# Streaming between the stages of a voice pipeline

Research for the voice bridge (`/home/crsmi/voice-bridge-mcp`) and the caller (`/home/crsmi/caller`). Date: 18 September 2026. No file in either repo was changed.

## 1. The bridge today

### The chain and where each stage waits

| Step | Code | Waits for |
|---|---|---|
| Frames arrive at 48 kHz | `src/transport.ts` `onAudio` | nothing |
| Utterance ends | `src/audio.ts` `Utterances.push` | `endOfTurnPauseMs` = 1500 ms of quiet after the last loud frame (`src/config.ts:237`) |
| Transcription | `src/ear.ts` `said` -> `stt.transcribe(wav)` | the whole utterance, written to a wav, then one request to `speech/stt_worker.py`. faster-whisper `small.en`, `vad_filter=True`, no partial results |
| The agent starts | `src/conversation.ts` `runTurn` -> `Session.ask` | the final transcript. `Session.ask` rejects a second question while one is pending (`src/session.ts:212`) |
| Sentences | `src/sentences.ts` `SentenceCollector` | `.`, `!`, `?` followed by whitespace, or a newline, or 240 chars |
| Synthesis | `src/speech.ts` `SpokenAhead.take` | the whole sentence becomes a whole wav in one worker request. The worker takes one request at a time |
| Playback | `src/transport.ts` `speak` | 20 ms frames, `until()` checked per frame |

The round trip (`src/latency.ts`) runs from the real end of speech to `measures.answering()`, which fires in `serve.ts` `say()` after `ahead.take(text)` resolves. So `answerMs` includes the synthesis of the first sentence and excludes playback.

### What commit `9b33ee0` ("make the next sentence while this one plays") overlaps

It adds `SpokenAhead` and the `next` callback on `Mouth.say`. When sentence N's wav is made and its bytes read, `ahead.start(next())` starts sentence N+1 and then N plays. Measured in the commit: four chatterbox sentences, 17.4 s before, 11.4 s after.

What it does overlap: synthesis of N+1 with playback of N.

What it does not overlap:

- Synthesis of the first sentence with anything. The first sentence is fully on the critical path: about 120-160 ms with kokoro, about 2.5-3 s with chatterbox (`docs/next.md`, `speech/chatterbox_worker.py`).
- Audio inside a sentence. Each wav is complete before its first frame goes out.
- Sentence N+2. The engine is serial, so N+2 waits for N+1 to finish, not for N to finish playing.
- Transcription with the pause. `stt.transcribe` starts only when the 1500 ms pause has elapsed.
- The agent with the transcript. The user message goes out only when the transcript is final.
- A barge-in with an in-flight synthesis. The commit says so: a barge-in during a prefetch waits for a synthesis it will not use, up to one chatterbox sentence.

The narration (`src/narrator.ts`) is not spoken in `serve.ts`; it goes to the console and the data channel (`src/serve.ts:127`). It is not on the audio path.

### Chris's numbers, from `~/.voice-bridge/record.jsonl`

101 `answered` events across 8 sessions, 17-18 September. Median unless stated.

| Quantity | Value |
|---|---|
| `answerMs` (end of speech to first sentence made), all sessions | 6033 ms |
| of which `pauseMs` (a setting) | 1500 ms |
| of which `transcribeMs` | 338 ms (p90 about 700 ms) |
| remainder: agent to first sentence + first-sentence synthesis + file I/O | 3907 ms (p90 23363 ms; tool-using turns) |
| utterance audio length | 4040 ms |
| `transcribeMs` / audio length | 0.07 |
| kokoro session, 17 Sep 13:07, n=44, `answerMs` | 4814 ms |
| chatterbox session, 18 Sep 14:45, n=39, `answerMs` | 7294 ms |

The chatterbox minus kokoro gap (about 2.5 s) matches the first-sentence synthesis cost. With kokoro, the agent's own time to the first sentence is about 3.7 s of the 4.8 s. `~/.voice-bridge/config.json` sets `ttsEngine: "kokoro"` today; the code default is chatterbox.

The record does not split the 3.9 s remainder. It has no timestamp for the first delta, the first sentence, or the synthesis. See section 5.

## 2. The caller today

`src/call/session.ts` builds a LiveKit `AgentSession` (`@livekit/agents` 1.8.1):

| Stage | How |
|---|---|
| VAD | Silero, `silero.VAD.load()` |
| STT | `sttNs.StreamAdapter(WhisperSTT, vad)`. The adapter calls `recognize` on VAD `END_OF_SPEECH`, with `interimResults: false` (`node_modules/@livekit/agents/dist/stt/stream_adapter.js`). Same `stt_worker.py` as the bridge |
| LLM | `openai.LLM` Haiku 4.5 via OpenRouter, streamed |
| TTS | `ttsNs.StreamAdapter(KokoroTTS, SentenceTokenizer)`. The adapter synthesizes sentences concurrently and queues frames in order (`dist/tts/stream_adapter.js:66-78`) |
| Turn detection | `inference.TurnDetector({ version: "v1-mini" })`, an audio end-of-turn model on CPU |
| Interruption | `minDuration`, `minWords`, `falseInterruptionTimeout`, `resumeFalseInterruption` from `state.ts` constants |

Shipped defaults in 1.8.1 (`dist/voice/turn_config/*.js`): endpointing `minDelay` 500 ms, `maxDelay` 3000 ms; with the turn detector 300 ms and 2500 ms; interruption `minDuration` 500 ms, `falseInterruptionTimeout` 2000 ms; preemptive generation `enabled: true`, `maxSpeechDuration` 10000 ms, `preemptiveTts` false. The docs agree: https://docs.livekit.io/reference/agents/turn-handling-options/

Preemptive generation in 1.8.1 fires on `FINAL_TRANSCRIPT` when VAD-based turn detection is on (`dist/voice/audio_recognition.js:872-883`), then `runEOUDetection` runs. So the LLM starts the moment whisper returns and overlaps the turn detector plus the endpointing delay. When the turn commits, the speculative reply is used if the transcript, chat context and tools are unchanged (`dist/voice/agent_activity.js:2174-2196`, logs `preemptiveLeadTime`).

`src/call/bridge.ts` records `eou`, `stt`, `ttft`, `ttfb` per turn. `ttft` is the first token; spec 3.4 says the first sentence is the right event. The caller already has the reference streaming shape. The rest of this report treats it as the control.

## 3. Techniques and sources

### 3.1 Streaming STT with partials and endpointing

- Deepgram: endpointing "enabled by default and set to 10 milliseconds"; `utterance_end_ms` example 1000; interim results are corrected as audio arrives. https://developers.deepgram.com/docs/endpointing and https://developers.deepgram.com/docs/interim-results
- whisper_streaming (LocalAgreement-2 over faster-whisper): "3.3 seconds latency on unsegmented long-form speech". Too slow for turn-taking as-is. https://github.com/ufal/whisper_streaming
- WhisperLive: faster-whisper backend, partial and committed segments over a websocket, no latency numbers. https://github.com/collabora/WhisperLive
- Kyutai STT: `stt-1b-en_fr` "~1B parameters, a 0.5 second delay, and a semantic VAD"; `stt-2.6b-en` "2.5 second delay"; weights CC-BY 4.0. https://github.com/kyutai-labs/delayed-streams-modeling
- Silero VAD: one 30 ms chunk under 1 ms on one CPU thread. https://github.com/snakers4/silero-vad
- LiveKit's own adapter for a non-streaming STT does what the bridge does: wait for VAD end of speech, then recognise once. Verified in `node_modules`.

What you could not verify: any published number for whisper streaming below 500 ms on short utterances. The 0.07 ratio in Chris's record says the whole utterance costs 7 percent of its length, so the saving from streaming is bounded by `transcribeMs`.

### 3.2 Starting the LLM on partial transcripts or speculatively

- LiveKit: "Preemptive generation speculatively starts an LLM response before the user's end of turn is confirmed"; "Only the LLM runs preemptively — TTS waits until the turn is confirmed"; discarded if context or tools change; costs tokens. https://docs.livekit.io/agents/build/audio/
- A third party measured `preemptiveLeadTime: 318` ms and reports "TTFT drops by 150-350ms", discards "below 5 percent of turns". This is a GitHub issue, not a vendor benchmark. https://github.com/mastra-ai/mastra/issues/22873
- Claude Code: a second user message on stdin during a turn "queues and runs as a second full turn after the first". https://github.com/anthropics/claude-code/issues/51078. The interrupt control request works in about 10 ms and ends the turn with `error_during_execution` (`docs/next.md`, measured 9 September).

### 3.3 Streaming LLM tokens into TTS at sentence or clause boundaries

- Pipecat: SENTENCE mode is the default; TOKEN mode "stream tokens directly for lower latency". https://docs.pipecat.ai/pipecat/learn/text-to-speech
- ElevenLabs websocket input buffers by `chunk_length_schedule` default `[120, 160, 250, 290]` characters before the first audio. https://elevenlabs.io/docs/api-reference/text-to-speech/v-1-text-to-speech-voice-id-stream-input
- Cartesia websocket: `continue` flag per chunk, `max_buffer_delay_ms` default 3000, `cancel` per context. https://docs.cartesia.ai/api-reference/tts/tts
- The caller's own measurement of the gap between first token and first sentence: Haiku 4.5 186 ms, Sonnet 5 727 ms; Haiku first sentence 868 ms median (`/home/crsmi/caller/docs/spec.md` 15.3).
- Twilio's budget: STT 350 ms, LLM first token 375 ms, TTS first byte 100 ms, 1115 ms mouth to ear; "Speech synthesis can begin as soon as the first tokens are received." https://www.twilio.com/en-us/blog/developers/best-practices/guide-core-latency-ai-voice-agents

### 3.4 TTS that accepts streamed text or streams audio out

- kokoro-onnx `create_stream`: splits phonemes into batches "Prefer splitting at punctuation marks, then at word boundaries", synthesizes in a background thread with a two-slot queue, yields the first chunk before the whole text is done. https://github.com/thewh1teagle/kokoro-onnx/blob/main/src/kokoro_onnx/__init__.py
- chatterbox-streaming fork: `generate_stream(chunk_size=50)`; "Latency to first chunk: 0.472s", "RTF (Real-Time Factor): 0.499" on a 4090. https://github.com/davidbrowne17/chatterbox-streaming. Upstream chatterbox has no streaming API. https://github.com/resemble-ai/chatterbox
- Chatterbox Turbo: 350M parameters, decoder "from 10 steps to just one", MIT, clones from a reference clip. https://huggingface.co/ResembleAI/chatterbox-turbo. Resemble claims 75 ms; not verified independently. https://www.resemble.ai/learn/models/chatterbox-turbo
- Kyutai Unmute: a cascade with streaming STT and TTS; TTS "~750ms" on one GPU, "~450ms" in production. https://github.com/kyutai-labs/unmute
- Cartesia Sonic: 40-90 ms time to first audio, vendor claim. https://www.cartesia.ai/product/python-text-to-speech-api-tts. ElevenLabs Flash: "~75ms" model time; a third-party median TTFB of 255 ms. https://elevenlabs.io/docs/overview/models and https://vexyl.ai/elevenlabs-tts-latency-test-2026-real-world-results/

### 3.5 Barge-in and cancellation across stages

- LiveKit defaults: interruption `min_duration` 0.5 s, `min_words` 0, `false_interruption_timeout` 2.0 s, `resume_false_interruption` true. https://docs.livekit.io/reference/agents/turn-handling-options/
- Pipecat: an interruption frame propagates and each processor cancels; `MinWordsInterruptionStrategy` (now `MinWordsUserTurnStartStrategy`). https://docs.pipecat.ai/server/utilities/interruption-strategies (page moved; the reference is https://reference-server.pipecat.ai/en/latest/api/pipecat.audio.interruptions.min_words_interruption_strategy.html)
- Vocode: `interrupt_sensitivity` low ignores backchannels; Deepgram endpointing `vad_threshold_ms` 500, `utterance_cutoff_ms` 1000. https://docs.vocode.dev/open-source/conversation-mechanics
- OpenAI Realtime: `interrupt_response`, server VAD example `silence_duration_ms: 500`, semantic VAD `eagerness`. https://developers.openai.com/api/docs/guides/realtime-vad
- The bridge already stops playback 5-6 ms after it notices a barge-in and holds the sentences (`docs/next.md`). Its detector needs 400 ms above 0.05 with a 200 ms gap tolerance, close to LiveKit's 500 ms.

### 3.6 Turn detection

- LiveKit end-of-utterance model: "135M parameter transformer based on SmolLM v2", "~50ms", "Reduces unintentional interruptions by 85%", "model predictions are used to dynamically shorten or extend the VAD silence timeout". https://livekit.com/blog/using-a-transformer-to-improve-end-of-turn-detection/. The audio detector `v1-mini` runs on CPU; with it the endpointing defaults become 0.3 s and 2.5 s. https://docs.livekit.io/agents/build/turns/turn-detector/
- Pipecat Smart Turn v3: "only 8 MB", "12ms on modern CPUs, 60ms on a low cost AWS instance", English 94.31 percent, audio-only over up to 8 s of the turn, weights and data open. https://www.daily.co/blog/announcing-smart-turn-v3-with-cpu-inference-in-just-12ms/ and https://github.com/pipecat-ai/smart-turn
- Human conversation: the mode of the response offset is between 0 and 200 ms across ten languages. Stivers et al. 2009, https://www.pnas.org/doi/10.1073/pnas.0903616106

### 3.7 Speech-to-speech as the alternative

- Moshi: "a theoretical latency of 160ms, 200ms in practice". https://arxiv.org/abs/2410.00037
- OpenAI Realtime `gpt-realtime-2.1`: "barge-in, low first-audio latency, natural turn taking, and realtime tool use"; no numbers on the page. https://developers.openai.com/api/docs/guides/realtime
- Independent phone-call benchmarks of cascaded platforms: Vapi median 1558 ms, Retell 1740 ms, Bland 1520 ms end of speech to first audio. https://openbenchmarks.com/voice-agent-latency/voice-agent-end-to-end-latency

## 4. Each technique against Chris's pipeline

Savings are medians against the record above unless stated. "Estimated" means computed from a component that the record already measures; "guess" means no local number exists.

### A. Speculative transcription during the pause (bridge)

What: at a short quiet (about 300 ms) start transcribing the recording so far. If speech resumes, drop the result. If the 1500 ms pause completes, the transcript is already there.

- Saves: about `transcribeMs`, 338 ms median, about 700 ms p90. Estimated: transcription takes 7 percent of the audio length, so it finishes inside the remaining 1200 ms of pause every time.
- Costs: a "tentative end" in `Utterances`, one in-flight promise in `Ear`, one wasted whisper call per resumed pause. No new model.
- Breaks: nothing visible. `Latency` must keep `transcribeMs` as the time the transcript was actually waited for, which becomes near zero.
- Applies to: the bridge. The caller already gets this shape from the adapter plus preemptive generation.

### B. Streaming STT model (bridge)

What: replace `small.en` with Kyutai STT 1B (0.5 s delay, semantic VAD) or a chunked faster-whisper.

- Saves: the same 338 ms as A, plus a possible cut of the pause from its semantic VAD. Not more than A on transcription.
- Costs: a new worker and model; the command corpus in `test/fixtures/heard.json` is tied to what `small.en` writes (ADR 0006) and must be regenerated; the `vad_filter` phantom guard goes.
- Breaks: the wake word forms (`cambridge`), the command matcher tuning.
- Applies to: bridge only. Not worth it while A is available.

### C. Speculative LLM start (bridge: no; caller: already on)

- Bridge: the agent is one Claude Code process. A second message queues; a discarded speculation must be interrupted and leaves the user message and the partial reply in the session's context; a speculative turn can run tools. Do not do this.
- Caller: on by default in 1.8.1 and it fires on whisper's final transcript. Verify in the worker log for "using preemptive generation" and `preemptiveLeadTime`. Expected saving equals the endpointing delay, 300 ms and up.

### D. Semantic turn detector to shorten the pause (bridge)

What: at 300-500 ms of quiet, ask Smart Turn v3 (8 MB, CPU, 12 ms) whether the turn sounds complete. Complete: finish the utterance now. Not complete: wait to 1500 ms as today.

- Saves: 900-1100 ms on utterances that sound complete (1500 minus 400-600). Estimated from the setting; how many of Chris's utterances sound complete at 400 ms is not measured.
- Costs: a fourth Python worker (ONNX, CPU), a second threshold in `Utterances`, and `Latency.speechEnded` must be told the pause actually used, since `pauseMs` is subtracted as a constant.
- Breaks: the wake-word hold is safe (`wakeHoldMs` already covers a split); the risk is a cut mid-sentence in road noise, which is the same class of fault the barge-in detector had on 10 September. Field test only.
- Applies to: the bridge. The caller runs LiveKit's `v1-mini` already; confirm it is live in the worker, because `session.ts:95` warns it pins to 1.0 outside the worker model.

### E. Shorter first sentence from the agent (bridge)

What: add to `voiceInstruction`: begin every answer with one short sentence. Check whether extended thinking is on in the bridge's Claude Code session; the stream would show thinking deltas before the first `text_delta`. `/config thinking=false` is accepted in `-p` mode. https://code.claude.com/docs/en/headless

- Saves: guess 300-500 ms from the token-to-sentence gap (the caller measured 727 ms for Sonnet 5, 186 ms for Haiku). If thinking is on, more; unknown.
- Costs: one line of config; one measurement.
- Breaks: the style of the first sentence; 6.6.1 brevity already bends.
- Applies to: the bridge. The caller's Haiku first sentences are 57 chars already.

### F. Clause-level split for the first sentence (both)

What: `SentenceCollector` also cuts the first sentence of a turn at `,`, `;` or a dash after about 40 chars.

- Saves: guess 100-300 ms for the bridge, under 100 ms for the caller. Depends on E.
- Costs: ten lines in a file the two projects share.
- Breaks: prosody across the cut; `restate` and `said` get finer pieces, harmless.

### G. Stream chatterbox audio, or swap to Turbo (bridge, only if the cloned voice returns)

What: first try Chatterbox Turbo in the same worker and time one sentence. If still over 500 ms, use the streaming fork and change the worker protocol to chunks.

- Saves: about 2 s on the first sentence of every answer and on every resume after a hold (2.5-3 s today; the fork reports 0.47 s to first chunk on a 4090, the 5070 is slower). Applies only while `ttsEngine` is chatterbox; `config.json` is kokoro today.
- Costs: streaming is the largest change here. `Transport.speak` takes a whole wav; it would take an async frame iterator. `SpokenAhead` prefetch becomes "start the stream and buffer". Kept lines stay whole files.
- Breaks: the "engine takes one request at a time" assumption. With RTF 0.5, N+1 can start when N's synthesis ends, before N's playback ends, so order still holds. Fixes the one cancellation gap: a barge-in can close the stream instead of waiting for a wav.
- Applies to: the bridge. The caller's kokoro sentences cost 46-178 ms; streaming buys nothing there.

### H. Kokoro `create_stream` (either)

Saves under 100 ms per first sentence. Not worth the protocol change.

### I. Speech-to-speech

Not applicable to the bridge: the agent is Claude Code by design (ADR 0001). The caller rejected it for control and tools (spec 4.2), and that trade is unmeasured; a measurement would need a cloud account.

## 5. Ranking, and what to measure first

Effort is days of work including a drive to verify. Saving is the median round trip on the bridge unless stated.

| Rank | Change | Saves | Effort | Ratio | Project |
|---|---|---|---|---|---|
| 1 | E. Short first sentence in the voice instruction; confirm thinking off | 300-500 ms, guess; more if thinking is on | 0.1 | very high | bridge |
| 2 | A. Transcribe during the pause | 338 ms median, 700 ms p90, estimated | 0.5 | high | bridge |
| 3 | D. Semantic turn detector, Smart Turn v3 | 900-1100 ms on complete-sounding turns, estimated | 2-3 plus a drive | high, uncertain | bridge; caller verify only |
| 4 | G. Chatterbox Turbo, then streaming | about 2 s, only with the cloned voice | 0.5 then 3 | high if that voice stays, else zero | bridge |
| 5 | F. Clause split of the first sentence | 100-300 ms, guess | 0.2 | medium | both |
| 6 | C. Preemptive generation | 300 ms and up | 0 (verify logs) | n/a | caller |
| 7 | B. Streaming STT model | no more than A | 2 | low | bridge |
| 8 | H. Kokoro streaming | under 100 ms | 1 | low | neither |
| 9 | I. Speech-to-speech | n/a | n/a | n/a | neither |

Do A first. It is contained to `src/audio.ts` and `src/ear.ts`, needs no new model, removes a whole stage from the critical path, and a wrong guess costs GPU time and nothing Chris can hear. E is cheaper but its saving is a guess until the measurement below exists; do E in the same session once the number is in.

Measure first, before any of the above: split the 3907 ms remainder. Add three timestamps to the `answered` event in `src/measures.ts` and `src/diagnostics.ts`: the first delta after `Session.ask`, the first sentence out of `SentenceCollector`, and the duration of `ahead.take` for that sentence. One session of ten turns gives the agent's own time to the first sentence. If that is 3 s, the ranking above stands but the ceiling is the agent, not the pipeline, and E and the model choice matter more than D. Second, count quiet stretches of 300 ms or more inside each utterance in `Utterances`; that number is how often D would cut Chris off, and it decides whether D is worth a drive.

## 6. What I do not know

- Whether extended thinking is on in the bridge's Claude Code session. Not visible in the record.
- The agent's time to first delta. Not recorded.
- How Chatterbox Turbo or the streaming fork perform on the RTX 5070. The only number is a 4090.
- Whether the caller's `v1-mini` turn detector and preemptive generation are live in the rehearsal worker. The code says yes by default; the logs would confirm.
- LiveKit's turn-detector latency numbers come from their own blog; no independent measurement found.
