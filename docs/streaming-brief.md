# Streaming: the brief for a spoken conversation

Written 21 September 2026 for a conversation in the car, and updated 27
September with chatterbox figures. It condenses [`streaming.md`](streaming.md)
(the research of 18 September) and the architecture review of 19 September.
For the figures of today, read `/diagnostics` or the record (section 6).

To the agent: talk this through out loud. Give numbers rounded to a tenth of
a second. Do not read a table or a path aloud unless Chris asks. Section 5
holds the questions that need an answer from Chris; ask one at a time.

## 1. The short answer

Most of the streaming is already done. The live voice is chatterbox with
`som_00295`. The round trip is about 8.4 seconds at the median. Three parts
own almost all of it: the agent's 2.9 seconds to its first word, chatterbox's
2.4 seconds for the first sentence, and the 1.5 second pause.

## 2. Where the time goes now

337 turns with chatterbox, 21 to 27 September: every `answered` line with
the full split. The parts add up to the whole on each turn, but the medians
do not add up.

| Part | Median | p90 | What sets it |
|---|---|---|---|
| The whole round trip | 8.4 s | 30.1 s | |
| The pause | 1.5 s | 1.5 s | `endOfTurnPauseMs`, a setting |
| Transcription, waited for | 0 s | 0.5 s | starts during the pause |
| The agent, to its first word | 2.9 s | 19.8 s | the model and the question |
| First word to first whole sentence | 0.3 s | 1.0 s | `SentenceCollector` |
| First sentence to sound | 2.4 s | 5.5 s | chatterbox on the GPU |

Only 17 percent of these turns came in under 5 seconds. The long p90 comes
from the agent's share.

Kokoro, for comparison: 17 turns on 20 and 21 September gave a median round
trip of 5.4 s, with 0.1 s for the first sentence. Before the changes of 19
September, the median was 6.0 seconds (4.8 with Kokoro only).

## 3. What already streams

| What | Commit |
|---|---|
| The reply, as text, word by word from Claude Code | from the start |
| The reply, cut into sentences, each spoken as soon as it is complete | from the start |
| The next sentence made while the current one plays | `9b33ee0` |
| Transcription started at a 400 ms quiet, used if the pause completes | `094b427` |
| Each sentence sent to the phone's screen before the voice reaches it | `dc324e3` |
| A short first sentence, asked for in the voice instruction | `e705a76` |
| A kept opener ("Okay.") that plays while the first sentence is made | `c0f4f83` |
| The turn detector, in shadow: it guesses and ends nothing | `f040436` |

The opener shipped on 24 September, but no `answered` line in the record
names an opener yet. Nobody has checked why.

## 4. What is left, in order

The letters D, F and G are the option letters of section 4 of
[`streaming.md`](streaming.md).

### G. Stream the audio (the cloned voice is live)

Chatterbox is the live voice, so the first sentence costs 2.4 s at the median,
on every answer and on every resume after a hold. Todo item 5 holds this work.

Chatterbox Turbo was timed on 21 September, with the same reference clip on
the RTX 5070. It took 0.81 s for 8 words and 1.44 s for 20 words. It is
faster, but it misses the target of 0.5 s, so it does not replace chatterbox
alone. Nobody has listened to it yet.

The next step is the chatterbox-streaming fork (0.5 s to the first chunk on a
4090; the 5070 is slower). Then:

- the worker sends chunks, not one wav;
- `Transport.speak` takes a stream of frames, not whole wav bytes;
- `SpokenAhead` starts a stream and buffers it, instead of making a file;
- a barge-in closes the stream, instead of waiting for a whole sentence
  it will not use;
- kept lines stay whole files.

This is the largest change of all the options: about three days, including a
drive.

### The agent's 2.9 seconds (not streaming, but the largest share)

Nothing in the pipeline shortens this. It depends on the model, the question
and any thinking. A warm process gives its first word in 0.62 s at the median,
so about a second of the agent's time on drives is not the model. Todo item 55
holds that search.

### D. A turn detector, to shorten the pause

The pause is 1.5 s on every turn. Pipecat Smart Turn v3 (8 MB, CPU, about
12 ms) runs in shadow since 25 September. At each tentative end it writes a
`turnGuess` line and ends nothing. Todo item 54 holds the data, the next drive
and the plan to let it end a turn.

- Saves: up to 1.1 s on turns that sound complete.
- Risk: it can cut Chris off mid-sentence. From 19 to 26 September, 278 of 530
  utterances held a quiet of 400 ms or more that Chris talked through.

### F. Cut the first sentence at a comma

Rejected on 21 September, with Kokoro: the first sentence was complete 0.03 s
after the first word, at the median. With chatterbox, the synthesis time grows
with the length of the sentence, so a shorter first sentence can save time.
That saving is not measured.

### Rejected earlier, and why

| Option | Why not |
|---|---|
| A streaming speech-to-text model | saves no more than the early transcription, and breaks the command corpus |
| Start the agent on a guess before the turn ends | one Claude Code process; a wrong guess stays in its context and can run tools |
| Kokoro audio streaming | saves under 0.1 s |
| Speech-to-speech models | the agent is Claude Code by design |

## 5. The questions for Chris

1. Is 2.9 seconds from the agent acceptable, or is a faster model worth
   trying for spoken turns?

## 6. Where to look for more

| Question | Where |
|---|---|
| The research and its sources | `docs/streaming.md` |
| The live split, now | `curl -sk https://127.0.0.1:3100/diagnostics`, or "sidetone, stats" |
| Every turn's split | `~/.sidetone/record.jsonl`, `kind: "answered"`: `agentMs`, `sentenceMs`, `synthesisMs` |
| False ends | the same file, `kind: "heard"` lines, field `falseEnds` |
| The turn detector's guesses | the same file, `kind: "turnGuess"` lines |
