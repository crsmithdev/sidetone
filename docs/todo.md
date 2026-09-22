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

Shipped 21 September 2026, reverted 22 September 2026: an in-app volume
slider (spec 4.2.1) set the gain of the bridge's audio track in the app,
apart from the Android stream volume. It shipped untested on a device; the
first real run showed no audible effect and, worse, playback loud enough to
defeat the phone's echo cancellation, so the bridge heard its own voice and
barged in on itself. Reverted rather than tuned, since call mode's stock
volume floor was never confirmed as the actual cause.

Done when the voice follows the volume control on the phone alone, in the car,
and on the bridge machine.

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
| One spoken test: "start a job that sleeps 60 s", then silence. | It proves the done condition in the room. |
| The call that auto mode refused on 21 September. | Two `claude -p` runs in auto mode started a job with no refusal. On 21 September 2026 Chris allowed the rule `Bash(scripts/job:*)` in `.claude/settings.local.json`. That file is not in git. |

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

## 12. Format text in the phone app chat

Noted 21 September 2026. Not started. Keep the selection of spec 17.14.

The chat shows every reply as plain text. Chris wants proper formatting: a link
is tappable, and bold text, code, lists and other markdown show as what they
are. The voice instruction asks the agent for plain sentences, so a spoken
reply has little markdown. A reply typed in the app, or a reply with a link or a
path, still gains from it. Find which markdown the replies really contain before
you pick a renderer. Keep it small: a Compose renderer for the few cases that
appear, not a full markdown library, unless the survey shows that many cases.

Done when a link in a bubble opens on a tap, and bold, code and lists show
formatted. Selection and copy (spec 17.14) must still work on formatted text,
and copy must give the plain text.

## 13. A three-button row for mic, audio and music

Noted 22 September 2026. Not started.

The row at `MainActivity.kt:266` (spec 17.10) holds two buttons, mic and
audio. Each button's text switches between a cut label and a resume label
("Cut the mic" / "Mic off — resume"). Chris wants a third button, for hold
music, added to the row, and wants the label switch dropped from all three:
each button keeps one label and shows its on/off state by color alone.

Done when the row holds three buttons, one each for mic, audio and music,
each with a fixed label and a color that shows its state.

## 14. Make the cues click-like, atonal and quieter

Noted 22 September 2026. Not started.

`src/cues.ts` (spec 15) plays a short detuned sine-pair note for each of
`heard`, `thinking` and `starting`. Chris wants a different character: closer
to a click than a tone, more atonal, and quieter than today. Keep the three
cues distinct from each other and audible over road noise (spec 15.4), the
two constraints the current design was tuned against.

Done when the three cues have the new character and still read as distinct
over road noise.

## 15. A gentle tone for hold-to-talk on and off

Noted 22 September 2026. Not started.

Hold-to-talk (`state.holding` in `Bridge.kt`, spec 9.5.1) has no cue today;
only `heard`, `thinking` and `starting` play a sound (spec 15). Chris wants a
very gentle tone when the hold starts and another when it releases, so the
toggle is audible without looking at the screen.

Done when starting and releasing hold-to-talk each play a distinct, gentle
cue.

## 16. The status row can show contradictory words

Noted 22 September 2026. Not started.

The row at `MainActivity.kt:228` (spec 17.10, 17.11) shows three separate
readings side by side: `statusWord(state.status)` for the room connection
("listening", "connecting", …), `state.quality` for the network
("Excellent"), and `signWord(state.sign)` for whether the bridge still says
it works ("working" or "no signal", `Work.kt`). Chris has seen "listening",
"Excellent" and "no signal" together, and it reads as a contradiction: the
room and network look fine, but "no signal" sounds like a connection problem
when it actually means the bridge process has stopped saying it works (spec
17.11).

Find a more compact, sensible way to show the three readings together, as one
state the eye reads at once rather than three words that can conflict.
Renaming "no signal" so it stops sounding like a network word may be part of
it. Once the screenshot-to-agent feature ships, Chris may attach a screenshot
of the confusing case here.

Done when the row cannot show two readings that sound like they contradict
each other, in no more room than it takes today.

## 17. Hold music can arm very late on a turn whose first content is one large tool call

Noted 22 September 2026. Not investigated yet.

On a turn on 22 September 2026, Chris felt the hold music (spec 15.7) came on
very late. That turn's own numbers, from `~/.sidetone/record.jsonl`: 69.6
seconds of agent time before any words, almost all of it one large tool call
(a several-thousand-word prompt as its argument) rather than a short one.
Spec 15.7.5 says a tool call makes a turn long the moment it starts, and the
music is meant to begin `holdMusicAfterMs` (8 seconds by default) after that.
If the bridge only counts a tool call as started once it has seen a
meaningful part of its argument, a tool call whose argument itself takes most
of a minute to stream would arm the long-turn flag, and the music, close to
the end of the wait rather than near the 8 second mark it was designed for.

No timestamp for when hold music itself starts or stops is logged today,
only the settings and the aggregate `answered` line, so this is a reading of
the mechanism, not a confirmed measurement.

Log when hold music actually starts and stops. Then look at a turn like this
one, agent time dominated by one large tool call, and see whether the flag
really arms late. Find out whether the fix is judging "the tool call has
started" from the first delta of the tool_use block rather than from how much
of it has streamed, or something else.

Done when a turn like this one gets hold music near the 8 second mark like an
ordinary long turn does, and the record shows when the music actually started
and stopped, so this can be checked again without guessing.

## 18. A tone at the true end of the agent's speaking

Noted 22 September 2026. Not started.

Chris cannot always tell whether the bridge has finished a reply or is only
paused between sentences of the same turn. A pause mid-turn is normal and
fine; he wants a clear, distinct signal exactly when the turn is truly done
speaking, so he knows when it is safe to talk without wondering if more is
coming. He wants this to be a click or a quiet tone, not a musical note, in
the same direction as item 14's redesign of the existing cues.

Find where the code already knows a turn is fully over, as opposed to
between sentences of the same turn, and play a short, quiet cue there,
distinct from `heard`, `thinking` and `starting` (spec 15) and from the
hold-to-talk tones of item 15.

Done when a click or quiet tone plays exactly once, at the true end of a
turn's speech, and never between sentences of the same turn.

## 19. Highlight the chat text as it is actually spoken

Noted 22 September 2026. Not investigated yet.

The official Claude app shows upcoming text greyed out, then brings each
part to full weight as the words are actually spoken, so the reading eye can
follow the voice. Chris wants something like that here, even if it only
works sentence by sentence rather than word by word.

The chat bubble already shows a sentence as soon as it is known, ahead of the
voice (the `sentence` message, src/messages.ts:66, spec 14.7) — that is the
greyed-out part, more or less, already. What is missing is a signal for when
a given sentence actually starts playing, so the app can light it up at the
right moment rather than as soon as it arrives. `Mouth` already tracks this
server-side: whether a sentence is playing, and which sentences Chris has
heard this turn, whole, in order (src/mouth.ts:196, :200). The research is
mostly in whether to send that as a new message kind, how it survives a
barge-in or a hold, and how MainActivity.kt's `TranscriptLine` (item 12
touches the same composable) renders a bubble that is partly lit and partly
not without fighting the formatting item 12 is adding.

Done when a bubble's text visibly lights up in step with the voice, at least
sentence by sentence, and stays correct through a barge-in and a hold.
