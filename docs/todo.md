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

23 September 2026: the app side of this is now a module of its own, `Joining`,
with the retry and the status word apart from the room, and `JoiningTest`
asserts the rule this item rests on: a refused pairing is the one end the app
gives up after, and every other reason waits and tries again. That is the app
answering for itself. It does not close the item, because no restart has been
watched since, and the case Chris hit may not be the app giving up at all.

Done when the service restarts and the app is listening again with no touch.

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

## 20. More hold music tracks, cycled, each resuming where it left off

Noted 22 September 2026. Not started.

Three parts to this.

First, more tracks. `config.holdMusicFile` (src/config.ts:177, :328) points at
one file, `~/.sidetone/hold/hold-music.mp3`. Chris wants a few more to choose
from.

Second, licensing. Chris wants to know whether he can use tracks he does not
hold the copyright to, since this runs only on his own machine for his own
use and nothing is distributed. He believes this likely falls under fair
use. That needs real thought, not a rubber stamp: fair use is fact-specific,
and playing a whole commercial track for its ordinary purpose (background
mood music), even privately, does not sit as cleanly under it as a
transformative use would. The lowest-risk path sidesteps the question
instead of resolving it: tracks that are royalty-free or carry a license
that explicitly allows this (Creative Commons, a stock-music library, a
personal-use license Chris already holds). Look into both paths and lay out
what each actually permits, rather than assuming either is fine.

Third, rotation and resume. Spec 15.10.1 today: the hold music plays once
per silent stretch, does not loop, and the next stretch plays the same track
again from the start. Chris wants multiple tracks in rotation, cycling
between them rather than repeating one, and wants each track to pick up
where it left off the last time it played rather than restarting from the
beginning every time. `Mouth` decodes the file once and keeps the samples in
memory (spec 15.9); this needs a position kept per track, not just per file.

Done when hold music has more than one track to draw from, each used under
terms Chris has actually confirmed rather than assumed, playback cycles
between tracks instead of repeating one, and a track resumes from its last
position instead of the start.

## 21. A web dashboard for turns, timing and cost

Noted 22 September 2026. Not started.

Chris wants a web dashboard: as much as can be shown of turn timing, cost,
and whatever else is useful for diagnostics, in one place he can look at
rather than reading `~/.sidetone/record.jsonl` by hand or asking "sidetone,
stats" out loud.

Some of this already exists and mostly needs a front end. `/diagnostics`
(src/serve.ts:146, backed by src/diagnostics.ts and src/measures.ts) already
hands back a live summary, recent events and the settings in force —
`docs/drive-tests-19-september.md` shows it read today with `curl`. But it
only keeps a recent window; `~/.sidetone/record.jsonl` holds the same kinds
of events (`heard`, `answered`, `spoke`, `barged`, `cutoff`, `session`,
`setting`) persisted across sessions, which a dashboard covering real history
would need to read as well.

One gap: turn cost is tracked live per session (`Session.costUsd`, sent to
clients in the `turn` message, src/session.ts) but is not currently written
to `record.jsonl`, so a historical cost view needs that added first.

Done when Chris can open a page and see turn timing and cost over time, not
just the live recent window `/diagnostics` gives today.

## 22. A desktop client

Noted 22 September 2026. Lower priority. Not started.

Chris wonders about an actual desktop client, alongside the phone app and
the existing browser client in `client/`. Not scoped beyond that yet — worth
finding out what a desktop client would give Chris that the browser client
and the phone app do not, before building anything.

Done when there is a clearer answer to what problem a desktop client solves,
or it turns out the browser client already covers it.

## 23. An architecture review of the delivery layer between the service and the app

Noted 22 September 2026. Not started.

The architecture review of 22 September (see items 1 through 5 of the
"queue up" work already running, and docs/todo.md item 4 above) covered the
service, `src/`. A later one is planned for the Android app. Chris wants a
third pass, in between the two: how the service actually gets things to the
app over the wire. Chunking, compression, message framing, and how
consistently those are handled across the different things that get sent.

Concretely this is at least: the screen log's chunking (`SCREEN_PART_BYTES`,
android/app/src/main/java/dev/crsmith/sidetone/ScreenLog.kt) and the
screenshot's (`Screenshot.kt`, `screenshotParts`), both against LiveKit's
data channel, which carries messages of only about 12-15 KiB; whether
anything is compressed before it goes out, given base64 alone inflates an
image by about a third; and the reliability difference already on record
from building the screenshot feature — the screen log keeps its entries and
retries on a dropped part, a screenshot does not, one bad part just drops the
whole image. Worth asking whether that difference is intentional or just
where each feature happened to land.

Done when there is a written review of this layer, the way the 22 September
one covered the service, that Chris can read and decide what to act on.

## 24. `/play` fights the agent's own speech and hold music

Noted 22 September 2026. Low priority. Not started.

Measured live on 22 September, playing Apple Music preview clips for Chris:
`/play` (src/serve.ts:175-193) stops the track it is playing the moment
`mouth.busy` or `transport.speaking` goes true, the same check that ends a
track for a barge-in or the audio going off. Two ways this bit the agent
today, not Chris directly, but it made the feature clumsy to drive:

- The agent called `/play`, then kept talking in the same turn ("Playing it
  now. That's Opus No. 1…"). Its own next sentence set `mouth.busy`, so the
  track played for about one second and stopped. The log: `[playing
  /tmp/preview-opus-no-1.m4a]` immediately followed by `[the track stopped]`.
- The agent then tried `/play` again for a second track while still inside
  one long tool-heavy turn. The turn's own length armed hold music (spec
  15.7.5, and see item 17), and hold music plays through the same path
  `/play` needs, so every attempt got `{"error":"the bridge is speaking or
  playing"}` for about two minutes straight, until the agent stopped calling
  tools and hold music cleared.

The agent worked around both by going silent and hand-timing waits around
the call, which is fragile and not something to rely on. Worth a cleaner way
for the agent (or a client) to play a one-off file without it being at war
with its own narration and hold music — maybe a queue instead of an
immediate stop-on-busy, maybe a way to ask "is the mouth free" without
guessing from silence.

Done when the agent can play a file and say something about it in the same
turn without one cutting the other short, and without a multi-minute retry
loop to get a turn in edgewise.

## 25. Playback volume sometimes jumps suddenly

Noted 22 September 2026. Not investigated yet.

Chris has heard the volume jump suddenly during playback, especially with
hold music. He suspects it may be tied to delivery to the phone, latency or
a connection issue, rather than the bridge itself, but is not sure.

One thing narrows it a little: hold music's gain is set once, at decode
time, not adjusted during playback (`Mouth` decodes the file once and
applies the gain in that decode, spec 15.9; the `gain` argument of
`wavFromFile` in src/audio.ts:69 is the only place a level is set). So a
jump mid-playback is unlikely to be the bridge changing its own level on the
fly; it more likely sits in the transport to the phone (the LiveKit/WebRTC
path) or the phone's own audio handling. This may or may not share a cause
with item 1 (the app ignoring the volume setting) — both sit in the same
phone audio path, worth checking together rather than assuming they are one
bug.

Get a specific case on record: the time, what was playing (a sentence, a
cue, hold music), and the status and quality shown on screen at that moment
(spec 17.10, 17.11 — see item 16, reworking that same row). A screenshot
from the new screenshot feature at the moment it happens would help pin the
state down.

Done when there is a specific case, with timing and network state on
record, enough to say from evidence rather than guess where the jump comes
from.

## 26. Automated coverage for a barge-in / echo-cancellation regression, before item 27

Noted 22 September 2026. Not started. Must land before item 27.

The volume-slider incident (item 1: "Shipped 21 September 2026, reverted 22
September 2026") shipped a gain change that was never wrong in the server's
own barge-in logic — it broke because real playback, on a real phone, was
loud enough to defeat the phone's hardware echo cancellation, so the bridge
heard itself and barged in on itself. That failure lives in the phone's
audio hardware and Android's echo canceller, not in anything test/ exercises
today.

What already exists: test/ear.test.ts, test/audio.test.ts, test/turn.test.ts,
test/mouth.test.ts and test/conversation.test.ts cover the server's own
barge-in decision logic well, and architecture-review item 1 (queued,
already running) is making that logic testable against the real object
graph instead of hand-built copies. None of that catches a real acoustic
feedback loop on a real device — that is a different category of test,
closer to hardware-in-the-loop than a unit test.

Chris wants a way to catch a regression like the volume-slider one in
testing, before it ships, not on a live drive. Figure out what is realistic:
a known-safe gain range asserted in a unit test, an Android instrumented
test that plays a track and checks the mic does not just hear the speaker
back unattenuated, or something else. This needs its own investigation; it
is not obviously a small addition to the existing suite.

Widen the pass before settling on that, though. Read back over the last
couple days of session transcripts — `~/.claude/projects/-home-crsmi-sidetone/*.jsonl`,
one file per session, roughly 20 September onward — for other friction that
came up along the way: things that broke, surprised Chris, or took a
work-around, the way the volume slider and the `/play` interruptions (item
24) did. Use those to suggest other areas worth automated coverage, not only
the echo-cancellation case. Say plainly what turned up and why each one
would, or would not, have been caught by a test.

Done when there is some automated check that would have caught the
volume-slider incident before it shipped, or a clear written reason none is
practical and what replaces it (for example, a mandatory device smoke test
before any audio-path change ships); and when the transcript read-back has
produced a short list of other testing gaps, if any turned up, for Chris to
weigh separately.

## 27. Decouple audio focus from echo cancellation, so the app stops holding priority over other audio

Noted 22 September 2026. Blocked on item 26 landing first.

Item 1's decision on 21 September was to keep call mode
(`AudioManager.MODE_IN_COMMUNICATION`) rather than switch to a
media-playback audio model, because call mode is what currently gives the
app LiveKit's echo cancellation, which barge-in depends on (spec 4.2, 11.4).
The cost of switching away was never scoped; it was rejected on the strength
of that reasoning alone. Chris also wants this because call mode holds
priority over other audio on the phone, which media playback would not.

Quick research on 22 September found a narrower option than "call mode or
hand-build a canceller." Echo cancellation on Android comes from the
microphone's capture audio source (`VOICE_COMMUNICATION`), which is
separate from `AudioManager`'s mode, the setting that makes the app act
like a phone call and take over audio focus from everything else on the
phone. Apps such as WhatsApp use the communication audio source for
cancellation while handling focus more like an ordinary app. LiveKit's own
Android SDK, already in use here, exposes this same separation:
`AudioOptions.focusMode` and `disableCommunicationModeWorkaround` sit apart
from its `echoCancellation` setting in `AudioCaptureOptions`. Neither is set
today — `android/app/src/main/java/dev/crsmith/sidetone/Bridge.kt:178` sets
only `echoCancellation = true`, `noiseSuppression = true` and
`autoGainControl = true`. Two things to keep in mind regardless of what's
chosen: the canceller only works if it can hear the assistant's own voice
through the path it watches, and it needs a few seconds after starting to
adapt.

This does not remove the risk item 1 already lived through: even a small
gain change inside call mode broke echo cancellation on a real device once.
Changing the focus/mode setup is at least as likely to move that same
failure mode around, which is why item 26 needs to land first.

Done when the app holds audio focus more like an ordinary app rather than a
phone call, without losing the echo cancellation barge-in depends on,
verified by whatever item 26 puts in place plus a real drive test.

## 28. A proper options menu in the Android app

Noted 22 September 2026. Not started.

Today the only way to change a setting is a voice command (spec 9, e.g.
"music on"/"music off") or editing the config file on the bridge machine by
hand. There is no settings screen in the app — MainActivity.kt has the
button row (item 13), the transcript, the text field and the End the turn
button, and nothing else. Chris wants a real options menu.

`src/config.ts`'s `IN_FORCE` list (config.ts:359-367) is every setting that
is already live-changeable and persists across restarts: hold music on/off,
its volume and its delay, cue volume, the TTS voice and engine, the wake
word, and a run of other tuning knobs besides (barge-in timing, speech
thresholds, chatterbox parameters). That whole list is not the menu — most
of it is internal tuning, not something Chris asks for from his phone. Start
from what he named, hold music volume and "things like that," and work out
with him which of the rest, if any, belong in a phone menu versus staying
voice-only or config-file-only.

This also gives item 20 (more hold music tracks, cycling) a natural home,
rather than another one-off control bolted onto the main screen.

Done when there is a settings screen in the app, reachable from the main
screen, that can change at least hold music's volume, and Chris has said
which other settings belong there.

## 29. Should a turn nobody asked for stream?

Noted 22 September 2026, from the architecture review of that day (item 3,
"An Answer module owns the agent's words on the way out"). The review rates
it "Worth exploring" and says it pays only if unprompted turns stream.

| Turn | What the client gets today |
|---|---|
| A turn Chris asked for (`runTurn`) | `blockStart`, `delta`, `blockEnd` and `sentence`, all with `answer`, then `turn` with `answer` |
| A turn nobody asked for, 11.11 (`unprompted`) | One `turn` with no `answer`, after the whole reply. The voice says it sentence by sentence through `reply`. |

The session already sends the deltas and blocks of an unprompted reply. The
conversation drops them, because no turn is open. To stream it, the bridge
opens an answer on the first delta between turns. This changes what the
client sees for 11.11. It also reverses the test "a block start that
arrives after the turn is over is not told" in `test/turn.test.ts`.

Decide whether an unprompted reply streams. If it does, one `Answer` type
serves both paths, and the `turn` with no `answer` goes from both clients.
If it does not, the closures in `runTurn` stay where they are: an `Answer`
type for one caller only moves them.

## 30. Compact the status row, and design it rather than grow it

Noted 23 September 2026. Not started. To be designed.

Item 16 fixed what the row *said*: the quality and the working sign now show
only while the room is live (spec 17.11.6), so it cannot read as a
contradiction. It did not touch what the row *is*. The row at
`MainActivity.kt:238` is still a line of separate pieces laid side by side, and
each piece was added on its own:

| Piece | What it shows |
|---|---|
| A 10 dp dot | primary when live, tertiary on a rejoin, outline otherwise |
| `statusWord(state.status)` | "connecting", "listening", "reconnecting", "rejoining", "disconnected" |
| `qualityWord(...)` | "excellent" to "poor", or "—", live only |
| `WorkingSign(...)` | a second dot, pulsing or red, plus "working" or "stalled", live only |
| A "Leave" button | |

So at its widest the row is two dots and three words before the button, on a
phone held at arm's length in a car. Two of the words are near synonyms of the
dot beside them, and the two dots mean different things while looking alike.
Chris wants it compacted: fewer marks, each earning its place, read in one
glance rather than parsed left to right.

The design is not settled and is Chris's to make. Things worth putting in front
of him: one mark instead of two, with colour and motion carrying the state that
the words carry now; the words kept only for the states that are genuinely
surprising; and whether the row needs the "Leave" button at all, given a
settings screen is coming (item 28).

Judge any candidate in the car, not at the desk. The row is read at a glance in
bright light, and the question is whether Chris knows the state before he has
read a word.

Done when the row shows the same states in fewer marks, Chris has picked the
design, and he has read it while driving.

## 31. The opening sentence may play after the hold music

Noted 23 September 2026. Not investigated yet.

Chris asked the agent to check something. He heard the clicks, then the hold
music. At the end of the hold music he heard "I'll go ahead and check", and the
results came at once. Chris thinks the opening sentence was out of order. It
should have played before the hold music. He says it is probably not new.

Find out when the opening sentence is queued, when it reaches the mouth, and
when the hold music starts. The record has `track` events and the sentence
events with times. Compare the order they show with the order Chris heard.
One cause to test: the hold music holds the mouth, and the first sentence
waits behind it until the turn is nearly over.

Done when the opening sentence plays before the hold music, or a written reason
says why it cannot.
