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

Chris tried the volume control at the desk on 21 September 2026. The desk case
is the phone app, not the web client or the machine mixer. One cause may
explain both cases.

Chris says the volume on the phone has a floor: he cannot lower it below a
minimum. This fits call mode (`MODE_IN_COMMUNICATION`). Android's voice-call
stream often has a minimum volume of 1 and never reaches 0. This is not
verified: no phone is on adb. The decision below stands: this does not
justify a switch to media audio.

Decision, 21 September 2026: do not change the audio type to media audio for
now. It would leave call mode, and call mode gives the echo cancellation that
barge-in needs (spec 4.2). Look for a fix that keeps call mode.

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

The order is fixed (21 September): each `sentence` and `turn` message names
its answer, and a client grows one line per answer.

| Want | Today |
|---|---|
| One chat bubble for each stage of a turn: the text before a tool call, and the text after it. | Not done. |
| Text appears word by word as the agent writes it, as in the Claude app. | Not done. |

The mark for a new bubble is a new block of the reply. Chris decided this on
21 September 2026: each separate section of a reply is one bubble, and a tool
call always splits the sections. The stream already carries the block
boundaries (`content_block_start` and `content_block_stop`), but
`src/protocol.ts` drops them as `other`. The word-by-word display needs
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

Tested 21 September in a `claude -p` stream-json process, with the bridge's
interrupt message 3 s after the work started:

| Background work | At the interrupt | When it ends |
|---|---|---|
| `Bash` with `run_in_background` | It keeps running. | The process starts a new turn and returns a second `result`. |
| `Agent` with `run_in_background` | It stops at once. | Nothing. |

So a subagent does not survive an interrupt. Background `Bash`, such as
`scripts/job` or `claude -p`, survives it. Two bridge changes are open, and
Chris chooses: queue Chris's speech without an interrupt, or raise
`interruptAfterMs`. The bridge already speaks a `result` that arrives with
no question in front of it (`Conversation.unprompted`).

Chris decided on 21 September 2026 to change nothing yet and to log first.
Each time Chris speaks over a running turn, `~/.sidetone/record.jsonl` gets a
`kind: "cutoff"` line with `waitedMs` and `interrupted`. After a few drives,
count `interrupted: true` against `false`. A high count of `true` argues for
a longer `interruptAfterMs`. The live service needs a restart to log it.

### b. A setup for long jobs

Built 21 September. `scripts/job <name> <command>` runs a command detached,
writes to `~/.sidetone/jobs/<id>/`, and posts to `/say` when it ends. The
bridge says "Job <name> finished." when no turn runs and nothing is playing.

| Open | Why |
|---|---|
| `scripts/job` jobs die when the service restarts. | A `setsid` job stays in the cgroup of `sidetone.service`, and the unit kills that group on a restart (`KillMode=control-group`). Seen 21 September 2026. Start the job with `systemd-run --user --collect` to fix it. |
| A restart of the service. | The running bridge does not have `/say` yet. |
| One spoken test: "start a job that sleeps 60 s", then silence. | It proves the done condition in the room. |
| The call that auto mode refused on 21 September. | Two `claude -p` runs in auto mode started a job with no refusal, so no allow rule is added yet. |

## 5. Faster speech from the good voices

Noted 21 September 2026. Step one measured 21 September.

The good voices are the chatterbox ones, and chatterbox is the default engine.
Its first sentence costs about 2.5 s, on every answer and on every resume after
a hold. Kokoro costs 0.1 s but is not the voice Chris wants.

Find out what shortens the time between the end of a request and the first
sound, with a chatterbox voice. The research is in section G of
[`docs/streaming-brief.md`](streaming-brief.md). In order of cost:

| Step | Cost | Result that closes it |
|---|---|---|
| Time Chatterbox Turbo in the existing worker, with the same reference clip. | About an hour. | Under 0.5 s a sentence: Turbo replaces chatterbox, and nothing needs to stream. |
| Use the chatterbox-streaming fork, so the first chunk plays as it is made. | About three days, with a drive. | The fork is slower on this card than on the 4090 that gave 0.5 s. |

Step one, measured 21 September 2026 on the RTX 5070 with `som_00295`. The
table gives the median of three fresh processes, in seconds:

| | 8 words | 20 words | Cold start |
|---|---|---|---|
| Chatterbox (live) | 1.79 | 3.53 | 28.2 |
| Chatterbox Turbo | 0.81 | 1.44 | 16.3 |

Turbo is 2.2 to 2.4 times faster but misses 0.5 s, so it does not replace
chatterbox alone. Its time grows with the sentence length, so only a stream
of the first chunk gets under 0.5 s. Turbo ignores `exaggeration` and `cfg`.
Nobody has listened to it yet. The runs, the wavs and the gaps are in
`~/.sidetone/jobs/turbo-0921-1211/result.md`.

Look for cheaper ideas too, on the speech end: a shorter first sentence, or a
kept line that plays while the first sentence is made. Measure each one with
`kind: "answered"` in `~/.sidetone/record.jsonl`, not by ear.

## 6. A quick design pass on the Android app

Noted 21 September 2026. Not started.

Chris wants a short polish pass, like the one the `impeccable` skill gives a
web page. The app is native Jetpack Compose (`MainActivity.kt`), and
`impeccable` is written for web front ends. Check first how much of it
applies. If little, use its questions as a checklist by hand: spacing, type,
colour, states, empty and error screens. Keep the pass small.

## 7. The app should reconnect when the bridge restarts

Noted 21 September 2026. Not investigated yet.

When the `sidetone` service restarts, Chris must force quit the app and open it
again. He wants the app to reconnect alone. `Bridge.kt` has a `RECONNECTING`
status and a retry every 5 s, so find out which restart case it misses: the
service comes back on the same address, or the session is lost.

Read 21 September from the service journal and the LiveKit log. LiveKit runs
in Docker apart from the bridge, so a bridge restart does not end the phone's
room. The app keeps the same room and sees no disconnect.

| Restart | What the logs show |
|---|---|
| Bridge, 09:02 and 09:15 | The phone was heard within a minute, with no touch. |
| Bridge, 10:05 | The phone stayed in the room (`numParticipants: 1` at the rejoin). The bridge heard it at 10:48 with no touch. |
| LiveKit container, 07:51 | The phone joined the new server 4 s after it started, with its saved token. |
| Bridge, 07:27 | Chris paired again at 07:35. The logs from before 07:51 are gone, so the cause is not known. |

No restart since 07:35 needed a touch. The next time one does, note the time
and the status word on the screen (`RECONNECTING`, `UNREACHABLE` or
`LISTENING`).

Done when the service restarts and the app is listening again with no touch.

## 8. Timestamps on messages in the app

Noted 21 September 2026. Not started.

Each message in the chat should show the time it was sent or received. Chris
said "on here", which this note reads as the chat in the phone app. Check
whether the web client (`client/index.html`) should match.

Item 3 changes the same chat code (`Messages.kt`, `Bridge.kt`), so build the
two together. Each bubble shows the clock time. Chris decided this on
21 September 2026.
