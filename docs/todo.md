# To do

Chris's list of things to build or look at. Add to the end. Delete an item
when it ships, and say where in the commit message.
[`docs/drive.md`](drive.md) holds the open car tests; this file holds the rest.

## 1. The volume of the phone audio path

Noted 21 September 2026. Not investigated yet. Item 25, the sudden jumps in
volume, merged into this item on 23 September 2026. Both are the level on the
phone audio path. They may or may not have one cause, so check them together
and do not assume they are one bug.

### a. The app ignores the volume setting

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

### b. Playback volume sometimes jumps suddenly

Noted 22 September 2026 as item 25. Not investigated yet.

Chris has heard the volume jump suddenly during playback, especially with
hold music. He suspects it may be tied to delivery to the phone, latency or
a connection issue, rather than the bridge itself, but is not sure.

One thing narrows it a little: hold music's gain is set once, at decode
time, not adjusted during playback (`Mouth` decodes the file once and
applies the gain in that decode, spec 15.9; the `gain` argument of
`wavFromFile` in src/audio.ts:69 is the only place a level is set). So a
jump mid-playback is unlikely to be the bridge changing its own level on the
fly; it more likely sits in the transport to the phone (the LiveKit/WebRTC
path) or the phone's own audio handling.

Get a specific case on record: the time, what was playing (a sentence, a
cue, hold music), and the status and quality shown on screen at that moment
(spec 17.10, 17.11; the status row is now `Reading.kt`). A screenshot
from the new screenshot feature at the moment it happens would help pin the
state down.

### Done

Done when the voice follows the volume control on the phone alone, in the car,
and on the bridge machine; and when a jump in volume has a specific case, with
timing and network state on record, enough to say from evidence rather than
guess where the jump comes from.

## 4. Long jobs and the subagent interrupt

Noted 21 September 2026. Part b, a setup for long jobs, is done and deleted.

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

This waits for Chris to decide. The count is in: 17 `interrupted: true`
against 16 `false`.

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

Decided 23 September 2026:

- The cue is one soft click figure, quieter and shorter than the others.
- It plays when the last sentence has finished playing in the app, not when the
  bridge finishes sending it.
- It plays after every turn that spoke, including unprompted reports such as a
  finished job. A turn with no speech gets nothing.
- `tones off` silences it.
- The figure is two clicks, dark to bright. It pairs with `thinking`, which is
  two clicks, bright then dark: down when the agent starts, up when it ends.
- Correction to check first: Chris thought the third cue, rising, plays on a
  reconnect. In `src/cues.ts` it is `starting`, three clicks dark to bright,
  and it plays when the Claude Code process restarts (`onRestart` in
  `src/conversation.ts`). Chris rarely hears it. Decided: the new two-click
  figure is a fourth cue, and `starting` stays as it is. The count of three
  still tells them apart.

## 19. Highlight the chat text as it is actually spoken

Noted 22 September 2026. Built 23 September 2026 on the branch
`highlight-speech`, not landed and not yet seen on a phone.

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

Decided 23 September 2026:

- The signal exists. Spec 14.13 defines the `speaking` message, so the bridge
  needs no change. The work is in the app.
- Lit means full weight. Upcoming text is grey. A sentence already spoken stays
  at full weight.
- The unit is one sentence. Word by word waits for timing from the voice engine.
- A barge-in cuts a sentence and the bridge says it again from its start. The
  bubble lights that sentence again when the message repeats. A sentence Chris
  never heard stays grey.
- A hold changes nothing. The last spoken sentence stays lit until the next
  `speaking` message.
- The formatting of item 12 stays as it is. `markdown()` in Markdown.kt makes
  one string for the bubble, and the app lays one grey colour span over the part
  after the spoken sentence. To find where that part starts, the app formats
  the raw text up to the end of the spoken sentence and measures its length.
  A sentence that ends inside a bold or code span may show a slightly wrong
  edge. That is accepted. If the app cannot find the spoken sentence in the
  bubble, it greys nothing.

Built 23 September 2026, spec 17.21. `spokenIn()` in `Spoken.kt` finds the
spoken sentence in the newest bubble of the agent that holds its words.
`Conversation.spoken` keeps the line and the end of the sentence. `greyAfter()`
lays the grey (`colors.outline`) over the formatted words after that end, in
`TranscriptLine`. Unit tests cover the search, the grey edge, a repeat after a
barge-in, a `turn` that arrives while the voice still speaks, and a sentence in
no bubble.

Two points differ from the Decided block:

- A `turn` no longer clears the spoken sentence. The bridge sends the `turn`
  when the agent finishes (src/conversation.ts:388, :589), not when the voice
  finishes. A clear there lit the rest of a long answer while the voice still
  said it.
- A sentence that no bubble holds, such as a reply from the bridge during a
  hold, keeps the grey where it was. "Greys nothing" applies only before any
  sentence is found. Otherwise a reply during a hold lit the words Chris never
  heard.

Not built:

- The grey is in one bubble. An answer of two blocks shows the second block at
  full weight while the voice still says the first.
- A new answer shows at full weight until its first `speaking` message. The
  gap is short: the voice reaches a sentence soon after the bubble shows it.
- The grey follows only the newest spoken sentence. When the next answer
  speaks, the unheard end of a cut answer goes to full weight.
- A sentence that repeats in one bubble matches its first place.
- Not seen on a phone or in the car. Done needs a look at a real answer, a
  barge-in and a hold.

## 20. More hold music tracks, cycled, each resuming where it left off

Noted 22 September 2026. Built 23 September 2026 on the branch `hold-tracks`,
not landed. It waits for review.

Two parts are open. The licence part is closed by the decision below. The
choice of a track in the app moved to item 28 on 23 September 2026.

First, more tracks. `config.holdMusicFile` (src/config.ts:177, :328) points at
one file, `~/.sidetone/hold/hold-music.mp3`. The bridge must read more than one.

Second, rotation and resume. Spec 15.10.1 today: the hold music plays once
per silent stretch, does not loop, and the next stretch plays the same track
again from the start. Chris wants multiple tracks in rotation, cycling
between them rather than repeating one, and wants each track to pick up
where it left off the last time it played rather than restarting from the
beginning every time. `Mouth` decodes the file once and keeps the samples in
memory (spec 15.9); this needs a position kept per track, not just per file.

Done when hold music has more than one track to draw from, playback cycles
between tracks instead of repeating one, and a track resumes from its last
position instead of the start.

Decided 23 September 2026:

- The licensing part is closed. Chris buys the tracks he uses.
- The bridge reads a folder. Every audio file in `~/.sidetone/hold/` is a
  track, so a new track needs no settings edit. `holdMusicFile` goes.
- The order is by file name, and wraps around at the end.
- The position of each track is kept in the memory of the bridge only. A restart
  starts every track from the beginning.
- A track resumes two seconds before where it stopped.
- Chris brings the tracks later on 23 September 2026.

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

Decided 23 September 2026:

- The dashboard shows everything the bridge exposes for debugging: the round
  trip, the audio timing, the transcripts, the events, the settings, and the
  screen log and screenshots of the turn.
- It has two views. The aggregate view shows the timings over time and the
  outliers. The turn view shows one turn from start to end, with all its data.
  Each aggregate point opens its turn.
- It reads the files that exist: `record.jsonl`, the journal, `~/.sidetone/screen/`
  and `~/.sidetone/screenshots/`. It joins them by turn number. It adds no store.
- Langfuse keeps the traces of the agent and the model. The dashboard does not
  copy them. The turn view links to the Langfuse trace of that turn.
- Build the turn view first. Decide the aggregate views after Chris has used it.
- What else to record, and the order to build it, is in
  [`observability-brief.md`](observability-brief.md).
- The page uses a component framework and a CSS framework. Before the build,
  make several mock-ups with the `impeccable` skill and the skills that fit.
  Chris picks one.

## 22. A desktop client

Noted 22 September 2026. Lower priority. Not started.

Chris wonders about an actual desktop client, alongside the phone app and
the existing browser client in `client/`. Not scoped beyond that yet — worth
finding out what a desktop client would give Chris that the browser client
and the phone app do not, before building anything.

Done when there is a clearer answer to what problem a desktop client solves,
or it turns out the browser client already covers it.

Discussed 23 September 2026. Two separate problems:

1. The desktop client. A laptop joins the same LiveKit room as the phone, with
   a microphone, a speaker and the transcript. The web page may already do most
   of this. Chris prefers this kind of interface and wants it on the desktop.
2. Work across several projects. The bridge has one voice, so one project
   speaks live at a time. Proposed rule: a current project, and the wake command
   "sidetone, switch to <project>". The other projects keep working. Their news
   waits until the current turn ends, as "Job finished" does now. Each project
   has its own conversation, working directory and permission mode.

Route, tested 23 September 2026: the bridge session can already list and message
the other Claude sessions on this machine (`ListAgents`, `SendMessage`), named
after their repos. Remote Control is not needed.

- An idle session in "prompting" mode answered a message at once, and sent the
  idle notice afterwards.
- A session that ran a background command received a second message while it
  ran, and answered both in order.
- Not tested: a session in the middle of a long model turn, a session that waits
  on a permission prompt, and a session in a stricter permission mode. Such a
  session can hold the message for its user to approve.
- Several sessions can exist for one repo, for example `sidetone-05`,
  `sidetone-77` and `sidetone-3b`. Each is a separate address. The switch needs
  a rule: the most recently active one, or the one Chris names.
- Replies come back as messages. The bridge does not see the other session's
  screen.

Open: whether the bridge attaches to sessions that Chris opened himself, or
starts one for each repo. The first is more flexible and depends on the tests
that are not yet done.

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
work-around, the way the volume slider and the `/play` interruptions of 22
September (fixed in 912e3ae) did. Use those to suggest other areas worth automated coverage, not only
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

The menu also holds the choice of hold music track, moved here from item 20
on 23 September 2026. Chris wants a few tracks to choose from. Item 20 makes
the bridge read and cycle them; this menu picks among them.

The path from the app to the bridge must grow for the hold music volume
slider. The bridge sends `settings` and takes `setting` from a client (spec
9.4.9, `Messages.kt:70`, `:235`), but it acts on four settings only. Hold
music volume is not one of them. The choice of track needs the same path.

Done when there is a settings screen in the app, reachable from the main
screen, that can change at least hold music's volume, and Chris has said
which other settings belong there, and that can choose the hold music track.

Decided 23 September 2026: the menu holds the verbosity selector (item 37), the
tones switch, and a volume control for the hold music. The voice choice and the
audio switch stay as they are, because each already has a command or a button.
The hold music volume is the existing `holdMusicGain` setting (0.4), so the
slider needs no new setting on the bridge. It sits beside item 1, the volume
the app ignores.

Decided 23 September 2026: the menu also holds the "Leave" button, moved from
the status row (item 30). It still quits the app. It may go away after item 27.

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

Decided 23 September 2026 (design not yet read in the car):

- One large dot replaces the two dots. Colour carries the room state: green for
  listening, amber for connecting or rejoining, red for disconnected. Motion
  carries the work: a slow pulse while the agent works, a fast blink when it
  stalls.
- Words show only for the surprising states: "reconnecting" and "disconnected".
  While the room listens or works, the row shows no word.
- The quality word goes. Quality shows as the ring of the dot, thin when poor.
- The "Leave" button leaves the row and moves to the options menu of item 28.
  Its behaviour does not change: it still quits the app.
- Leave may go away later. If item 27 lets the app stop using the phone call
  audio mode, a reconnect button that cuts the connection and stays in the app
  could replace it. Decide that after item 27.

Built 23 September 2026 on branch `status-dot`, not landed and not yet read in
the car. `reading()` in `Reading.kt` gives the colour, the ring and the word, and
`StatusDot` in `MainActivity.kt` draws them. Until item 28 exists, "Leave" is
the one entry of a "⋮" menu at the end of the row. "signal lost" keeps its word
beside "reconnecting" and "disconnected", because it is a link that is down too.

## 33. Garbled speech: first, let the agent hear the audio it sent

Noted 23 September 2026. Not started. Items 32 and 34 merged into this item on
23 September 2026.

Three reports of bad speech are open: the garbled pre-rendered replies (part b),
the repeated ".ts" (part c), and regular speech that comes out garbled now and
then. All three ask one question first: is the sound bad at the bridge? Part a
builds the tool that answers it, and it comes first.

### a. Let the agent hear the audio it sent

The agent cannot hear its own voice. On 23 September Chris reported garbled
replies (part b). He also reports that regular speech comes out garbled now and
then, and no cause is known. The agent could only read the record, and the
record holds text and timings, not sound. No code keeps outgoing audio.
`echo.ts` (e9063e0) compares words, not sound.

Keep the audio of the last few replies, so the agent can inspect it. Two parts:

1. Keep a bounded set of the most recent outgoing clips on disk, with the text
   each clip was made from, the time, and whether it came from a stored clip or
   fresh synthesis. Delete the oldest first.
2. Give the agent a way to check a clip: transcribe it with the speech worker
   and compare the result with the source text. A large difference marks a
   garbled clip. Also report the length, the sample rate and the peak.

Limit: a copy taken in the bridge does not show a fault that starts later, in
the network, the room or the phone's decoder. If the copy is clean and Chris
still hears garbling, the fault is after the bridge. A second copy taken on the
phone would then be needed.

Decide how many clips to keep, and whether the copy is opt-in, since it stores
speech.

### b. The pre-rendered replies come out garbled

Noted 23 September 2026 as item 32. Not investigated yet.

Chris said "sidetone mute" and "sidetone unmute" on 23 September. The replies
"Muted." and "Listening." came out garbled twice. He says the sounds are in the
wrong order. A reply the voice engine speaks fresh, "Job delivery-review
finished.", was not reported as garbled.

The record shows `synthesisMs` 0 for both replies. This suggests they play from
a stored clip. The journal shows no engine error.

The stored clips exist: `keptLines` (`mouth.ts:71`) and `SpokenAhead` with
`kept` (`speech.ts:283`) write under `~/.sidetone/spoken/<engine>-<signature>/`.
Five such folders exist, some from old signatures.

Compare their format, sample rate and length with the live engine's output.
Play one by itself, and play it through the room.

### c. The voice said ".ts" about twelve times in a row

Noted 23 September 2026 as item 34. Not investigated yet.

In the reply that reported the three finished jobs, Chris heard the voice say
".ts" about twelve times in a row. It did not show in the transcript on the
screen. The reply named files such as `src/sentences.ts` and
`src/conversation.ts`, but not twelve times.

The text is clean. The `spoke` lines of that reply in `~/.sidetone/record.jsonl`
name each path once (at 1790181535318 and 1790181544578). So the repeat is in
the engine or a stored clip, not the text, and it may be the same fault as
part b. No code turns a path into speech: `sentences.ts` and `mouth.ts` have no
match. Find out whether chatterbox loops on a token like `.ts`. A speakable
form of a path would avoid it.

### Done

Done when the agent can name the last clips, run the check on one, and say
whether a garbled reply was garbled at the bridge; when the pre-rendered
replies sound the same as a fresh reply, or a written reason says why they
cannot; and when the cause of the repeat is known, and a path in a reply is
spoken once.

## 35. Permissions stop the agent, and the spoken confirm word may not exist

Noted 23 September 2026. Not investigated yet.

On 23 September 2026 the permission check refused a headless `claude -p
--dangerously-skip-permissions` job that earlier jobs had run without trouble.
The agent had to stop and ask Chris. Chris then gave permission by voice, and
the same command ran.

Chris remembers an early plan: for anything dangerous he would say a specific
word to continue. He does not remember that it ever fired. A search of
`docs/sidetone-spec.md` finds no such rule.

Two parts:

1. Find what the check refuses and why it refused this time, and set the
   permissions so that `scripts/job` and its `claude -p` jobs run without a
   stop. Chris should not have to repeat a grant by voice.
2. Find out what happened to the spoken confirm word. Look in the earlier
   plans, the vault and the git log. Then decide with Chris whether to build
   it, and for which actions.

Done when a job started by `scripts/job` does not stop on a permission, and the
confirm word is either built or removed from the plans.

## 36. Review every wake-word command

Noted 23 September 2026. Not started.

Chris wants a review of all the commands that follow the wake word, the ones in
`src/commands.ts`: what each does, which phrases reach it, which ones are
missing, which ones nobody uses, and which ones clash. Check each one against
`docs/sidetone-spec.md` 9 and the heard corpus (ADR 0006).

Done when there is a written list of the commands with a keep, change, add or
drop decision for each one.

Counts from `~/.sidetone/record.jsonl`, 17 to 23 September 2026. The bridge has
22 commands. Six fired: end turn 24, carry on 5, stats 4, mute 3, unmute 3,
interrupt on 2. The wake word came 6 times with no command after it. The other
16 never fired.

Decided 23 September 2026:

- Drop `summarize`. It overlaps with `where`, and item 37 covers short replies.
- Drop the bare `tones` and the bare `interrupt`. Each is ambiguous beside its
  on and off forms.
- Change `clearContext`. It needs the two words "clear context". The bare word
  "clear" no longer clears the session.
- Keep the other 12 unused commands: audio on and off (the safety net of 11.12),
  music on and off, tones on and off, interrupt off, `restate`, `usage` (until
  item 21) and the two voice commands.
- No command needs three words. Every form in `src/commands.ts` is one or two.
- Remove "continue" from `carryOn`. It keeps "carry on", "go on" and "the
  rest". "Continue" is the confirm word of item 35 and has one job.
- Still to do: the five commands item 37 adds.

## 37. A verbosity setting, as a command and in the app

Noted 23 September 2026. The bridge side is built on the `verbosity` branch:
the setting, the line in each turn's prompt, the five commands, and the
`verbosity` key a client may set (9.4.9, 9.4.10). The app selector waits on
item 28.

Chris wants to set how much the agent says: a voice command after the wake
word, and a control in the app. This is the same idea as the tone commands
(`tones`, `tones on`, `tones off`) but for the length of the reply.

Decide first what the levels are, and how the setting reaches the agent: as a
line in the prompt, a setting the bridge holds, or both. Then add the command,
the control in the options menu of item 28, and a test.

Done when Chris can say a command or tap a control and the next reply is
shorter or longer.

Decided 23 September 2026:

- Three levels: brief, normal and full. Brief is one or two sentences and only
  the result. Normal is the behaviour today. Full gives the reasoning and more
  detail.
- The bridge holds the level and adds one line naming it to the prompt of each
  turn. The voice command and the app set the same value.
- The level is saved in the settings file and survives a restart and a new
  session.
- Voice commands after the wake word: `verbosity brief`, `verbosity normal`,
  `verbosity full`, and `shorter` and `longer` to move one level. `shorter` at
  brief stays at brief.
- The app shows a three-way selector in the options menu of item 28. The status
  row does not show the level, because item 30 makes that row smaller.

Decided 23 September 2026 (item 35):

- The confirm word is "continue".
- It is needed for the irreversible actions: a force push, the deletion of a
  remote branch, `rm -rf` outside the project, and the drop of a production
  database. Every other action runs without a word.
- When a permission check blocks any other action, such as the start of a
  headless job, the agent asks Chris in one sentence. Chris says "continue" and
  the agent runs the action. This replaces a grant in the settings file, and
  Chris can still make one.
- "Continue" is a common word. The bridge must count it as the confirm word
  only as the answer to a question the agent just asked, not at any other time.

Found later the same day: an agreement word already exists. `agreementWord` in
`src/config.ts` is spoken in the checkpoint reply of `src/conversation.ts`:
"Say <word> to let it run on." Read it before the confirm word is built, and
build "continue" on that path instead of a second one. The default of
`agreementWord` is already "continue".

## 38. A screenshot from the phone does not reach the agent, and the status shows twice

Noted 23 September 2026. Part 2 built, not landed. Part 1 not investigated.

Chris saw a status message twice, and took a screenshot to show it. The
screenshot did not reach the agent. Chris does not know which status doubled:
the row in the app, or a spoken message from the bridge such as a job start or
finish line.

Two parts:

1. Find what the screenshot showed. Until a picture can arrive, Chris says in
   words where it doubled.
2. Give Chris a way to send an image from the phone to the agent. The bridge
   passes speech and text only. Decide the route: a share target in the app that
   puts the file in `~/.sidetone/share/`, or a message kind on the control
   channel. The agent then reads the file.

Design, agreed 23 September 2026. The screenshot handler already saves the
file to `~/.sidetone/screenshots/`. Only the link to Chris's words is missing.

- A saved screenshot stays pending. It joins the next turn, and the turn text
  names the file path. The agent opens the file when it needs to.
- The pending screenshot expires after about two minutes, so an old picture
  never joins an unrelated turn.
- The app shows the thumbnail in the transcript with a mark "attached to your
  next message". A tap drops it.
- Several screenshots before one turn all join that turn, in order.
- A screenshot that arrives after Chris speaks does not join the turn in
  progress. That would race with the answer (11.11). It waits for the next turn.
- A screenshot with no words does not wake the agent. It stays pending.

Built 23 September 2026 on the branch `screenshot-link`, not landed (spec
14.12.5 to 14.12.7, 17.18.5):

- The bridge keeps each written screenshot pending, and the next turn takes
  all of them in order. A line for the agent names each file, and the
  transcript does not show that line.
- A pending screenshot expires after 2 minutes. The bridge takes the pending
  screenshots when it decides that the words start a turn, so one that
  arrives later waits for the next turn. A screenshot alone starts no turn.
- The bridge tells the app `screenshot` with a state: `pending`, `sent`,
  `expired` or `dropped`. The app shows the thumbnail with the mark
  "attached to your next message", and a tap sends a drop request.
- Tests: `test/screenshot.test.ts`, the fixture, `ConversationTest`,
  `ScreenshotTest` and `MessagesTest`.

Not done:

- Part 1: nobody has found which status doubled.
- Nobody has tried it on the phone. The thumbnail, the mark and the tap
  are not tested on a device, and no agent has opened a file that a turn
  named.
- The bridge forgets the pending screenshots when it restarts, and nothing
  tells the app. The mark then stays "attached to your next message", but
  no turn takes the screenshot.

Done when Chris can send a screenshot from the phone and the agent can open it,
and the double status is found or shown not to exist.

## 39. The app sends no crash report, and nobody has checked it for stability

Noted 23 September 2026. Part 1 built on branch `crash-report`, not landed and
not tried on the phone. Part 2 investigated in
`~/.sidetone/findings/stability-39b.md`; no fix made.

Built (spec 14.14, 17.20): an uncaught-exception handler in the app writes
the time, the thread, the stack trace and the app state to a file in the
app's storage, and lets the crash go on. After the next connect, the app
sends each file as one `crash` message and deletes it when the send
succeeds. The bridge writes `~/.sidetone/crashes/<id>.txt` and logs
`crash report at`.

Not built: a report of a native crash or an ANR. The findings recommend
`getHistoricalProcessExitReasons` on each launch for these. Not done: the
forced crash on the phone that the done line below asks for.

Before this, the app had no crash handler. After a crash, Chris sees a closed app and the
agent sees nothing. The screen log shows what the app displayed, but not why
it stopped.

Two parts:

1. Add a crash reporter. An uncaught-exception handler saves the stack trace,
   the time and the app state to a file, then lets the crash go on. On the next
   launch the app sends the file to the bridge. The bridge writes it to
   `~/.sidetone/crashes/` and logs `crash report at`. The agent reads it from
   there.
2. Make one pass over the app for stability. Check each of these, and write
   what was found:
   - The lifecycle of the foreground service and the room: start, stop, restart
     by the system.
   - Work on the main thread that can freeze the screen.
   - Coroutines that outlive their screen, and leaks of the context.
   - Errors from LiveKit, the network and the audio device that the app does not
     catch.
   - Permission loss while the app runs, for the microphone and notifications.
   - State that the app loses on a rotation or a process death.
   - The device's own tools: StrictMode in the debug build, and the Android
     vitals view of ANRs.

Done when a forced crash on the phone gives a file in `~/.sidetone/crashes/`
with the stack trace, and each check in part 2 has a finding or a fix.

## 40. The app learns of a new build only when it joins the room

Noted 23 September 2026. Built 23 September 2026 on branch `apk-push`, not
landed. Not yet tried on the phone.

What is built (spec 17.15.5 and 17.15.6): `watchApk` in `src/apk.ts` looks at
the file every 2 seconds through `ApkHash`. When the hash changes, and two
looks in a row agree, `src/serve.ts` sends `{"kind":"apk","apk":{url,sha256}}`
to the room. The app decodes it as `Incoming.Offer` and gives the existing
`Effect.Offer`, so `Bridge.offer` shows or clears the button. The `protocol`
message is unchanged. The page ignores the new kind.

Still to do: build the app while the phone is in the room, and see the
button within about 4 seconds of the end of the build.

The bridge offers the app in the `protocol` message (spec 17.15.1). It sends
that message when a client joins: `transport.onParticipant` in `src/serve.ts`.
A phone that is already in the room when a build ends hears nothing. Chris
must swipe the app away and open it again before "Update the app" appears.

The fix: when the hash of the file changes, the bridge sends the offer to every
client in the room. `ApkHash` already computes the hash again when the file
changes. The app must accept the offer at any time and show the button, and
must clear an old offer when the new hash equals its own.

Open point: choose the message. Either send `protocol` again, or add a smaller
message kind that carries only `apk`. Prefer the smaller one, so a repeat of
`protocol` does not reset other state in the app.

Done when a build that ends while the phone is in the room makes the button
appear on the phone within seconds, with no leave and no restart.

## 41. Voice input after the app was closed for a while

Noted 23 September 2026. Not investigated.

At about 13:55 on 23 September the bridge lost the voice of Chris. The journal
showed the phone open and cut its microphone every two to four seconds, and
Chris did not know why. The microphone was cut, and hold-to-talk presses opened
it for a moment. After a restart of the app and the update, input worked again.
The app had been closed or in the background for a while before.

Check whether the app has a fault in its audio input after it was closed or
in the background for a long time:

- The microphone permission and the foreground service of type microphone
  (`BridgeService.kt`): does Android stop them in the background?
- The track after the app returns to the front: does the app publish a new
  track, or does it keep a dead one? See 18.9 for the rejoin path.
- The state of the microphone button after the app returns: does it keep "cut"
  from before, without a sign that Chris can see?
- The round of cuts and opens in the journal: what caused each one, a press, the
  state of the app or the system?

This links to item 39, part 2 (the stability pass) and to the finding in
`~/.sidetone/findings/stability-39b.md`.

Done when a test with the app in the background for an hour, then in front
again, gives a working microphone with no touch, or a fix for the cause.

## 42. The bridge cannot tell which build of the app is running

Noted 23 September 2026. Not started.

On 23 September Chris tried three builds of the app in one hour: the media
build with the hardware canceller, the same with the software canceller, and the
build on `main`. The bridge could not say which one was in the room. The record
has only the build the bridge serves (`ApkHash`), not the build the phone runs.
Chris also had to guess whether an update had taken.

The app should say its build hash to the bridge when it joins the room, in a
message the bridge journals and puts in the record. The hash is the sha256 of
the APK that the bridge serves, so the two compare directly. The app can also
show it in its menu.

Done when the journal line for a joining client names its build, and "sidetone,
stats" or the record says whether it is the build the bridge serves now.

## 43. Words in a chat bubble arrive scrambled on a bad connection

Noted 23 September 2026. Not started.

At 16:33 on a weak link, the phone showed a bubble with words out of order and
words cut in half. One example: "but it Dropping such only logs it. a turn".
Another: "canran, perio route celler and aud connection". The bridge journal holds
the same text intact, so the damage happens between the bridge and the app.

The screenshot is `~/.sidetone/screenshots/1790206414025.jpg`. The screen log
for the conversation is in `~/.sidetone/screen/`. Compare what the app showed
with what the bridge sent for that turn, and find where the words break: the
send order, a lost or repeated chunk, or the way the app joins the chunks.

Done when a bubble on a weak link shows the words in the order the bridge sent
them, or a report says why it cannot.

## 44. Change more settings without a rebuild or a restart

Noted 23 September 2026. Not started.

Chris tries a setting such as the hardware or software echo canceller by
building a new app, installing it and restarting the bridge. Each try costs
minutes, and it made the build in the room hard to know (item 42).

Move as many settings as possible out of the code and into values that change
while the app and the bridge run. Some changes will always need a build or a
restart, such as a new permission or a new engine. The aim is that the common
ones do not.

Two ways to change a setting:

- From the bridge to the phone. The agent or a script sends a settings message
  and the app applies it at once, or at the next room join. Candidates: the
  echo canceller (hardware or software), the audio mode and focus, the noise
  suppression and gain, and the volume gates.
- From the phone to the bridge. The options menu (item 28) sends a setting and
  the bridge applies it without a restart. Candidates: the thresholds
  `minSpeechPeak` and `bargeInLevel`, the pause length, the voice, the echo
  drop of item 1 of the echo research, and the hold music.

Start with a list of every setting in `Audio.kt`, `Bridge.kt`, and the bridge
config, and mark each one as fixed, applied at join, or applied at once. Reuse
the settings message and the config file that exist now; add no new channel.

Done when Chris switches the echo canceller and one bridge threshold from a
menu or a command, and the next turn uses the new value with no build and no
restart.
