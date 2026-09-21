# Streaming: the brief for a spoken conversation

Written 21 September 2026 for a conversation in the car. It condenses
[`streaming.md`](streaming.md) (the research of 18 September) and the
architecture review of 19 September, and adds the first measured split of
the round trip.

To the agent: talk this through out loud. Give numbers rounded to a tenth of
a second. Do not read a table or a path aloud unless Chris asks. Section 5
holds the questions that need an answer from Chris; ask one at a time.

## 1. The short answer

Most of the streaming is already done. The round trip is now about 4.3
seconds, and two things own almost all of it: the 1.5 second pause, and the
agent's own 2.2 seconds before its first word. Streaming the audio saves
little with Kokoro. It pays only if the cloned voice returns.

## 2. Where the time goes now

18 turns on 20 September, 09:52 to 09:58, the first data with the split.
Medians. The sample is small.

| Part | Median | p90 | What sets it |
|---|---|---|---|
| The whole round trip | 4.3 s | 6.4 s | |
| The pause | 1.5 s | 1.5 s | `endOfTurnPauseMs`, a setting |
| Transcription, waited for | 0 s | 0 s | starts during the pause now |
| The agent, to its first word | 2.2 s | 3.7 s | the model and the question |
| First word to first whole sentence | 0.03 s | 0.5 s | `SentenceCollector` |
| First sentence to sound | 0.1 s | 0.2 s | Kokoro on the GPU |

Before the changes of 19 September, the median was 6.0 seconds (4.8 with
Kokoro only), and 0.3 to 0.7 seconds of it was transcription.

## 3. What already streams

| What | Commit |
|---|---|
| The reply, as text, word by word from Claude Code | from the start |
| The reply, cut into sentences, each spoken as soon as it is complete | from the start |
| The next sentence made while the current one plays | `9b33ee0` |
| Transcription started at a 400 ms quiet, used if the pause completes | `094b427` |
| Each sentence sent to the phone's screen before the voice reaches it | `dc324e3` |
| A short first sentence, asked for in the voice instruction | `e705a76` |

## 4. What is left, in order

### D. A turn detector, to shorten the pause (the largest lever)

The pause is 1.5 s on every turn. A small audio model (Pipecat Smart Turn v3:
8 MB, CPU, about 12 ms) can say whether a turn sounds complete.

How it fits: the ear already has a "tentative end" at 400 ms of quiet, and
transcription already starts there. The detector would run at the same point.
If the turn sounds complete, the utterance ends at once, and the transcript is
already on its way. If not, the ear waits to 1.5 s as it does now.

- Saves: up to 1.1 s on turns that sound complete.
- Costs: a fourth Python worker, one branch in `Utterances`, and `Latency`
  must use the pause that actually ran, not the setting.
- Risk: it can cut Chris off mid-sentence. The record counts the places where
  that could happen ("false ends"): 6 in 22 utterances, in 4 of the 22. A
  plain 400 ms cut would have cut off about one turn in five. The detector
  must be right at exactly those points, and only a drive can show it.

### The agent's 2.2 seconds (not streaming, but the largest share)

Nothing in the pipeline shortens this. It depends on the model, the question
and any thinking. Thinking measured zero on the turns checked, but a hard
question can still think. The levers are the model setting and the voice
instruction, not code.

### G. Stream the audio (only with the cloned voice)

With Kokoro, the first sentence costs 0.1 s, so audio streaming saves less
than that. With Chatterbox and `som_00295`, the first sentence costs about
2.5 s, on every answer and on every resume after a hold.

The order of work:

1. Try Chatterbox Turbo in the existing worker: one decoder step, the same
   reference clip. Time one sentence at the desk: about an hour. If it is
   under half a second, it replaces Chatterbox and nothing needs to stream.
2. If not, use the chatterbox-streaming fork (0.5 s to the first chunk on a
   4090; the 5070 is slower). Then:
   - the worker sends chunks, not one wav;
   - `Transport.speak` takes a stream of frames, not whole wav bytes;
   - `SpokenAhead` starts a stream and buffers it, instead of making a file;
   - a barge-in closes the stream, instead of waiting for a whole sentence
     it will not use;
   - kept lines stay whole files.

   This is the largest change of all the options: about three days,
   including a drive.

### F. Cut the first sentence at a comma

Rejected by the numbers: the first sentence is complete 0.03 s after the first
word, at the median.

### Rejected earlier, and why

| Option | Why not |
|---|---|
| A streaming speech-to-text model | saves no more than the early transcription, and breaks the command corpus |
| Start the agent on a guess before the turn ends | one Claude Code process; a wrong guess stays in its context and can run tools |
| Kokoro audio streaming | saves under 0.1 s |
| Speech-to-speech models | the agent is Claude Code by design |

## 5. The questions for Chris

1. Do you want the cloned voice back? If yes, the first step is the hour of
   Turbo timing. If no, G closes, and the Chatterbox worker, its environment
   and its settings can go.
2. Is one turn in five with a false end worth the risk of a turn detector?
   The other option is more data first: another drive with the false-end
   count, then decide.
3. Is 2.2 seconds from the agent acceptable, or is a faster model worth
   trying for spoken turns?

## 6. Where to look for more

| Question | Where |
|---|---|
| The research and its sources | `docs/streaming.md` |
| The live split, now | `curl -sk https://127.0.0.1:3100/diagnostics`, or "sidetone, stats" |
| Every turn's split | `~/.sidetone/record.jsonl`, `kind: "answered"`: `agentMs`, `sentenceMs`, `synthesisMs` |
| False ends | the same file, `kind: "heard"` lines, field `falseEnds` |
