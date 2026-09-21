# To do

Chris's list of things to build or look at. Add to the end. Delete an item
when it ships, and say where in the commit message.
[`docs/drive.md`](drive.md) holds the open car tests; this file holds the rest.

## 1. The app ignores the volume setting

Noted 21 September 2026. Not investigated yet.

| Where | What Chris sees |
|---|---|
| Car | The car volume control works. |
| Phone alone | The volume setting has little or no effect. |
| Desk, from the bridge machine | The voice plays at full level, even with the volume all the way down. |

Find out how the audio path takes its level. A search of the `.ts` and `.kt`
files finds only `cueVolume`, which scales the cues, and the gain in
`src/audio.ts`. It finds no code that reads a system or phone volume.

Done when the voice follows the volume control on the phone alone, in the car,
and on the bridge machine.

## 2. Push to talk, or hold to talk, in the app

Noted 21 September 2026. Not designed yet.

Today Chris cuts and uncuts the microphone. The spoken commands `mute` and
`unmute` do it (9.5), and the app has a muted track. Chris wants a button in
the app that does the same job by touch.

Two forms are possible. Chris has not chosen one.

| Form | The microphone is open |
|---|---|
| Hold to talk | While Chris holds the button. |
| Push to talk | From one press until the next press. |

Decide first whether the button replaces the mute command or sits beside it,
and what barge-in does while the microphone is closed (9.5).

## 3. How replies appear in the phone app

Noted 21 September 2026. Not investigated yet.

| Want | Today |
|---|---|
| Replies arrive in the order the agent wrote them. | Some replies arrive out of order. |
| One chat bubble for each stage of a turn: the text before a tool call, and the text after it. | Not done. |
| Text appears word by word as the agent writes it, as in the Claude app. | Not done. |

Find the cause of the wrong order first. Then decide what marks a new bubble.
A tool call is one mark; there may be others. The word-by-word display needs
the bridge to send partial text, which is the streaming work in
[`docs/streaming-brief.md`](streaming-brief.md).

## 4. Long jobs and the subagent interrupt

Noted 21 September 2026. Chris wants part b today.

### a. Keep subagents alive through an interrupt

Measured 21 September. Chris speaks while a turn runs. After
`interruptAfterMs` (5 s) the bridge sends an interrupt. The interrupt stops
every running subagent. Two research agents died at the second of an interrupt.
An interrupt after the turn ends kills nothing, but Chris cannot tell by ear
which case he is in.

Find out if a subagent can survive an interrupt at all. Two bridge changes are
open and untested: queue Chris's speech without an interrupt, or raise
`interruptAfterMs`.

### b. A setup for long jobs

Until part a has an answer, long work runs as a detached process, not as a
subagent. A detached process survived the same interrupt. Two things are
missing:

| Missing | Why it matters |
|---|---|
| A standing setup, so the agent can start any detached job without a refusal. | The permission classifier refused a research agent twice on 21 September. |
| A way to know that a job finished. | A detached process sends no completion notice. |

Done when the agent starts a long job, ends the turn, and says by voice when
the job ends, with no help from Chris.
