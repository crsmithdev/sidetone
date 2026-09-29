# To do

Chris's list of things to build or look at. Add to the end with `aleph todo add sidetone`. When an
item ships, `aleph todo done sidetone <n>` sets its status and it stays where it
is; `aleph todo list sidetone --status done` is the Done list. [`docs/testing.md`](testing.md) holds the open car tests; this file holds
the rest. Item numbers never change: commits, the spec and the vault quote them.

## 1. The volume of the phone audio path
---
id: 1
status: done
created: 2026-09-24
updated: 2026-09-24
priority: medium
labels: []
---

with item 25 merged in. Closed 24
September 2026, answered by the echo work of 23 and 24 September (15ed8e8,
adfe8b0). The level on the phone alone is a property of call mode, and the
car check requires call mode. The in-app slider (spec 4.2.1) shipped 21
September and was reverted 22 September: it defeated the phone's canceller.
What is still true about the phone's audio path is in item 26. The volume
jump has no case on record; item 26 says how to get one.

## 4. Long jobs and the subagent interrupt
---
id: 4
status: done
created: 2026-09-21
updated: 2026-09-29
priority: medium
labels: []
---

Noted 21 September 2026. Part b, a setup for long jobs, is done and deleted.
Part a waits for Chris to decide.

### a. Keep subagents alive through an interrupt

Measured 21 September. Chris speaks while a turn runs. At that time the bridge
sent an interrupt after `interruptAfterMs` (5 s). The interrupt stops
every running subagent. Two research agents died at the second of an interrupt.
An interrupt after the turn ends kills nothing, but Chris cannot tell by ear
which case he is in.

Tested 21 September in a `claude -p` stream-json process, with the bridge's
interrupt message 3 s after the work started:

| Background work | At the interrupt | When it ends |
|---|---|---|
| `Bash` with `run_in_background` | It keeps running. | The process starts a new turn and returns a second `result`. |
| `Agent` with `run_in_background` | It stops at once. | Nothing. |

So a subagent does not survive an interrupt. Background `Bash` survives it. The
workaround is in `CLAUDE.md`: long work runs detached with `aleph job`, never as
a subagent. `aleph job` replaced `scripts/job` in 2225aeb. The bridge speaks a
`result` that arrives with no question in front of it
(`Conversation.unprompted`).

The interrupt has a second cost, found under item 38: a barge-in during a job
tool call makes Claude Code report the call "rejected" after the command has
run, and the agent runs it again.

Chris decided on 21 September 2026 to change nothing yet and to log first.
Each time Chris speaks over a running turn, `~/.sidetone/record.jsonl` gets a
`kind: "cutoff"` line with `waitedMs` and `interrupted`. The count on 24
September: 31 `interrupted: true` against 79 `false`.

Decided and built 24 September 2026 (ec187aa, spec 11.9): speech mid-turn goes
into the running turn as a stream-json user message, with no interrupt. "Stop"
and "end the turn" still interrupt. Measured first, 3 of 3 each: a message sent
during a tool call joins the turn at the next tool boundary (one result); one
sent during the last text runs as a second turn (two results). The bridge
speaks only text from a message that started after the injection. Not yet used
in the car.

Since then (731ca2c, f80dca6): `interruptAfterMs` is removed. The bridge runs
Claude Code with `--replay-user-messages` and takes the reply to be the first
message after the echo of Chris's words (8 of 8 runs), which closes the race.
Two utterances during the last text merge into one turn (6 of 6). The note in
front of his words says they are his and not tool output: the agent obeyed in
18 of 20 runs, against 7 of 10 before. Chris chose that over a voice
instruction line that gave 10 of 10 by telling the agent to trust any text of
that shape.

Done when it has been used in the car and a correction mid-turn reached the
agent with no re-run of a job.

### Notes

- 2026-09-29 07:36: Tested live in the days before 29 September 2026, by Chris.

## 5. Faster speech from the good voices
---
id: 5
status: open
created: 2026-09-21
updated: 2026-09-21
priority: medium
labels: []
---

Noted 21 September 2026. Step one measured 21 September. One part built 24
September 2026:

- eebbd2b: a resume plays the clip that a barge-in cut, and the record has the
  worker's times.

The good voices are the chatterbox ones, and chatterbox is the default engine.
Its first sentence costs about 2.5 s, on every answer and on every resume after
a hold. Kokoro costs 0.1 s but is not the voice Chris wants.

Find out what shortens the time between the end of a request and the first
sound, with a chatterbox voice. The research is in section G of
[`docs/design.md`](design.md#g-stream-the-audio-the-cloned-voice-is-live). In order of cost:

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

Still to do: listen to Turbo, and decide whether its voice is good enough to
carry the stream. Look for cheaper ideas too, on the speech end, such as a
shorter first sentence. Measure each one with `kind: "answered"` in
`~/.sidetone/record.jsonl`, not by ear.

Done when the first sound of a chatterbox answer comes in under a second, or a
written reason says what it costs and Chris has said no.

## 18. A tone at the true end of the agent's speaking
---
id: 18
status: done
created: 2026-09-24
updated: 2026-09-24
priority: medium
labels: []
---

Landed 24 September
2026 (1a9228a, spec 15.15). A fourth cue: two clicks dark to bright, quieter
and shorter than the others, the pair of `thinking`. The true end is the line
after the second `mouth.drained()` in `runTurn`; the frames go behind the
last sentence, so the phone plays it after the last sample. A barge-in that
ends a turn gets no cue, a hold keeps it waiting, and `starting` keeps its
three rising clicks. `tones off` silences it.

## 19. Highlight the chat text as it is actually spoken
---
id: 19
status: done
created: 2026-09-23
updated: 2026-09-29
priority: medium
labels: []
---

Landed 23 September
2026 (cdab5b1, spec 17.21). Not yet seen on a phone. Two limits not in the
spec: the grey follows only the newest spoken sentence, so the unheard end of
a cut answer goes to full weight when the next answer speaks; and a sentence
that repeats in one bubble matches its first place.

### Notes

- 2026-09-29 07:36: Tested live by Chris in the days before 29 September 2026; the 'not yet tried' line above is out of date.

## 20. More hold music tracks, cycled, each resuming where it left off
---
id: 20
status: done
created: 2026-09-23
updated: 2026-09-23
priority: medium
labels: []
---

Landed 23 September 2026 (ca27825, spec 15.10.1). Every audio file in
`~/.sidetone/hold/` is a track, in file-name order, wrapping; the position is
in memory only, and a track resumes two seconds before where it stopped.
The licence question is closed: Chris buys the tracks. The choice of a track
is item 28.

## 21. A web dashboard for turns, timing and cost
---
id: 21
status: open
created: 2026-09-22
updated: 2026-09-22
priority: medium
labels: []
---

Noted 22 September 2026. Designed 23 September. Not started.

Chris wants a web dashboard: as much as can be shown of turn timing, cost,
and whatever else is useful for diagnostics, in one place he can look at
rather than reading `~/.sidetone/record.jsonl` by hand or asking "sidetone,
stats" out loud.

Some of this already exists and mostly needs a front end. `/diagnostics`
(src/routes.ts, backed by src/diagnostics.ts and src/measures.ts) hands back a
live summary, recent events and the settings in force, but only a recent
window. `~/.sidetone/record.jsonl` holds the same kinds of events across
sessions. One gap: turn cost is tracked live per session (`Session.costUsd`,
sent to clients in the `turn` message) but is not written to `record.jsonl`,
so a historical cost view needs that added first. Still true on 24 September.

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
  [`design.md`](design.md#observability).
- The page uses a component framework and a CSS framework. Before the build,
  make several mock-ups with the `impeccable` skill and the skills that fit.
  Chris picks one.

Done when Chris can open a page and see one turn from start to end, and turn
timing and cost over time, not just the live recent window `/diagnostics`
gives today.

## 22. A desktop client
---
id: 22
status: open
created: 2026-09-22
updated: 2026-09-22
priority: medium
labels: []
---

Noted 22 September 2026. Lower priority. Discussed 23 September. Not started.

Chris wonders about an actual desktop client, alongside the phone app and
the existing browser client in `client/`.

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

Done when there is a clearer answer to what problem a desktop client solves,
or it turns out the browser client already covers it; and when the three
untested session cases have a result.

## 26. Automated coverage for a barge-in / echo-cancellation regression, before item 27
---
id: 26
status: done
created: 2026-09-28
updated: 2026-09-28
priority: medium
labels: []
---

Closed 28 September 2026 (15ed8e8, 9a49cb9, adfe8b0; spec
4.2.2, 18.13). Item 1 closed into it on 24 September. A unit test cannot
hear the phone, so there are three parts:

| Part | What it catches | Runs |
| --- | --- | --- |
| `Audio.kt` and `AudioTest` (4.2.2, 18.13.1) | an audio setup that has not passed the echo check, and an audio-path call outside `Audio.kt` | `./gradlew testDebugUnitTest` |
| `bun scripts/echo-check.ts` (18.13) | a canceller that does not hold; it refuses a cut microphone and a dead capture | the bridge machine, with the phone in the room |
| `test/echo-path.ts` (9a49cb9) | the bridge's side of an echo, through a modelled canceller into `Ear.frame` | `bun test` |

Limits: at peak 0.54 with 300 ms bursts and dips over 200 ms, the barge-in
gate never fires, so it guards only a canceller that fails outright, and a
canceller that leaks onsets leaves the words (18.10.1, 18.10.3) as the only
guard. The setup that ships passed the check in the car on 24 September
(`Audio.CHECKED_ON`); run it again before the audio setup changes. Chris
weighed the open row and the synthesis alarm and closed the item, with the
synthesis alarm not built.

## 27. Decouple audio focus from echo cancellation, so the app stops holding priority over other audio
---
id: 27
status: done
created: 2026-09-24
updated: 2026-09-24
priority: medium
labels: []
---

Closed 24 September 2026 (a991872; the work in
15ed8e8, adfe8b0, cd636d6). The app cannot give it, and the reason is the
car. Call mode over Bluetooth SCO passes the echo check, but the car hears an
HFP call and parks its own media for the whole time the app is in the room.
Media mode over A2DP lets music play, but the canceller fails: in the car the
whole passage came back, 14.9 s at peak 0.54 (testing.md test 15 at ea9d252). Releasing
the focus changes nothing, and in LiveKit 2.28.2 the routing and the focus
are one flag, so no focus meant the earpiece; the app now routes a no-focus
setup itself (spec 4.2.2.1). Chris rejected a mode switch per turn: a second
of SCO setup and a connect tone each time. Superseded by item 49. The
research is `~/.sidetone/findings/echo-cancellation-23-september.md`: on
A2DP no documented canceller has the reply as a reference, and a server-side
canceller is an experiment, not a fix.

## 28. A proper options menu in the Android app
---
id: 28
status: done
created: 2026-09-28
updated: 2026-09-28
priority: medium
labels: []
---

with item 50 merged in.
Closed 28 September 2026 (010a92d, spec 17.22; 9df5cc8). The gear opens an
options screen under the status row with the verbosity selector, the tones
switch, the hold music volume slider and "Quit"; the gear or a back gesture
closes it. Each control sends `setting` and shows only what the next
`settings` says. The choice of a hold music track was dropped: the folder is
the setting. Chris used the screen on the phone, and every control worked.

## 30. Compact the status row, and design it rather than grow it
---
id: 30
status: done
created: 2026-09-23
updated: 2026-09-29
priority: medium
labels: []
---

Landed 23
September 2026 (1815e29, spec 17.11.6). One dot: colour for the room state,
motion for the work, the ring for the quality; "Leave" into the menu. Item 45
changed the word rule the same day: the word shows in every state. Not yet
read in the car. The thought of a reconnect button in place of "Leave" went
to item 49.

### Notes

- 2026-09-29 07:36: Tested live by Chris in the days before 29 September 2026; the 'not yet tried' line above is out of date.

## 33. Garbled speech: first, let the agent hear the audio it sent
---
id: 33
status: done
created: 2026-09-24
updated: 2026-09-24
priority: medium
labels: []
---

with
items 32 and 34 merged in. Parts a and b landed 23 September 2026 (ad0a0bc,
spec 11.6.1, 18.14), part c 24 September 2026 (c582cf2). The format was never
the cause: chatterbox garbles one-word text. The stored "Muted." of 18
September said "I'm gonna kill Tevrazigan!", "Stopped." was 120 ms of
silence, and fresh takes of "Muted." came out clean twice in twelve. A kept
line is kept only when the speech worker hears its text, and the store was
rechecked on 24 September. Chatterbox loops on ".ts": a sentence with a path
garbled in 30 of 50 takes and looped in 14, and "src" comes out as "erks";
a path spelled in upper case with spaces was clean in 30 of 30. The next
report of garbled speech is settled from `bun scripts/sent-check.ts`. On
28 September item 69 found the same fault in live sentences of one or two
words, and the bridge now joins or checks them (spec 5.6.2, 11.6.5).

## 35. Permissions stop the agent, and the spoken confirm word may not exist
---
id: 35
status: done
created: 2026-09-23
updated: 2026-09-29
priority: medium
labels: []
---

Noted 23 September 2026. Investigated 23 September 2026,
`~/.sidetone/findings/permissions-35.md`. The finding answers both questions.
The gate is built (f388a42, b17463f, 1560391). What is left is one use by
voice in the room.

On 23 September 2026 the permission check refused a headless `claude -p
--dangerously-skip-permissions` job that earlier jobs had run without trouble.
The agent had to stop and ask Chris. Chris then gave permission by voice, and
the same command ran.

Part 1, answered. The refusal came from the auto mode classifier: "Permission
for this action was denied by the Claude Code auto mode classifier. Reason:
[Create Unsafe Agents]." One refusal in ten such calls that day. The same
command passed 43 s later, after Chris said "Go ahead and try and get around
it": the classifier reads the conversation and took that as consent. Why:

- The bridge starts the agent with no `--permission-mode`, so it takes
  `defaultMode: "auto"` from `~/.claude/settings.json`.
- The bare `Bash` allow rule there is stripped in auto mode as too broad.
- `Bash(scripts/job:*)` in `sidetone/.claude/settings.local.json` did not match,
  because the command began with `unset CLAUDECODE` and variable assignments,
  not with `scripts/job`.
- The `autoMode.environment` block in `~/.claude/settings.json` describes the
  `imagegen` repo, not Sidetone, so the classifier gets the wrong context.

Part 2, answered. The confirm word exists. Item 35 said the spec has no such
rule; it has one in 6.3 and 10, and ADR 0009 records it. `agreementWord` in
`src/config.ts` defaults to "continue", `read` in `src/commands.ts` sets
`agreed`, and the gate is `askFirst` in `src/conversation.ts`. It gates two
actions of the bridge only: the clear of the context, and the checkpoint of a
turn at 10 minutes. It never fired: the record from 18 September holds no gate
question. The bridge cannot see the agent's own permission checks, because it
passes no `--permission-prompt-tool` and reads no `can_use_tool` request. So
the word cannot gate a force push or an `rm -rf` of the agent today.

Decided 23 September 2026:

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
- Build it on the `agreementWord` path, not a second one (spec 9.4.12).

Points 1 to 5 of the work:

1. Closed. An `autoMode.allow` rule for `scripts/job`. `aleph job` replaced
   `scripts/job` in 2225aeb, so the rule has nothing to match.
2. Closed. A test of three jobs started through `scripts/job`, for the same
   reason. The done line below tests `aleph job` instead.
3. Built 24 September 2026 (f388a42, spec 10.7-10.11). The bridge passes
   `--permission-prompt-tool stdio` and `permissions.ask` rules in `--settings`,
   because auto mode let 3 of 3 force pushes through with no request when the
   prompt tool was alone. `src/gated.ts` picks the four out; each waits for
   "continue", and every other asked command is allowed. Not yet used live.
4. Done 24 September 2026 (b17463f). The agreement word agrees only alone or
   beside a plain yes, so "do not continue" does not agree.
5. Done 24 September 2026 (1560391). The matcher looks inside `bash -c`,
   `eval`, `$(…)`, `xargs` and `find`, and gates a command it cannot read.
   Item 58 gates a shell that reads from a pipe.

Done when a job started by `aleph job` from a spoken turn does not stop on a
permission, and a gated action has been agreed and refused once by voice in
the room.

### Notes

- 2026-09-29 07:36: Tested live in the days before 29 September 2026, by Chris.

## 36. Review every wake-word command
---
id: 36
status: done
created: 2026-09-24
updated: 2026-09-24
priority: medium
labels: []
---

Closed 24 September 2026. The review
is `~/.sidetone/findings/wake-36.md`. The clashes landed in 59343d6 and
e066b4c; in the wake-word hold, a command now needs its exact words. Spec
9.4.13 is a table of all 24 commands, and 9.5 names the four that work while
muted. `stats` has no section of its own.

## 37. A verbosity setting, as a command and in the app
---
id: 37
status: done
created: 2026-09-24
updated: 2026-09-24
priority: medium
labels: []
---

Bridge landed 23
September 2026 (c621b40, spec 9.4.10), the app selector with item 28
(010a92d). Three levels, one line at the head of each turn's prompt, saved
in the settings file; the commands are `verbosity brief`, `verbosity
normal`, `verbosity full`, `shorter` and `longer`.

## 38. A screenshot from the phone does not reach the agent, and the status shows twice
---
id: 38
status: done
created: 2026-09-28
updated: 2026-09-28
priority: medium
labels: []
---

Closed 28 September 2026 (ad48d25, spec 14.12.5 to 14.12.7,
17.18.5). The double was the job lines: a barge-in during the job tool call
made Claude Code report it "rejected" after it ran, and the agent started
each job twice (`~/.sidetone/findings/double-status-38.md`). The screenshot
reached the bridge, but the agent did not look in `~/.sidetone/screenshots/`.
The next turn now names each pending screenshot, which expires after 2
minutes. On the phone the agent opened a screenshot Chris sent. A known
limit: a bridge restart forgets the pending screenshots, and the app mark
stays.

## 39. The app sends no crash report, and nobody has checked it for stability
---
id: 39
status: done
created: 2026-09-23
updated: 2026-09-29
priority: medium
labels: []
---

Noted 23 September 2026. Part 1 built and landed 23 September 2026 (dbd43d7,
spec 14.14, 17.20), not tried on the phone. Part 2 investigated 23 September
2026, `~/.sidetone/findings/stability-39b.md`, from the code only, with no
phone attached. No fix made.

Part 1, what was built: an uncaught-exception handler in the app writes the
time, the thread, the stack trace and the app state to a file in the app's
storage, and lets the crash go on. After the next connect, the app sends each
file as one `crash` message and deletes it when the send succeeds. The bridge
writes `~/.sidetone/crashes/<id>.txt` and logs `crash report at`. It catches
only an error in the app's own code (17.20.3).

Part 2, the findings:

| Check | Worst finding | Severity |
|---|---|---|
| Service and room lifecycle | The mic, audio and music cuts live in `Bridge.State` only, so after a process death all three are on again and the microphone opens without a word | medium |
| Main-thread work | `sendScreenLog` encodes the whole backlog, up to 2,000 entries, on the main thread each second, and parses it again to count | medium |
| Coroutines and context leaks | No context leak. A pairing in flight is lost on a rotation | low |
| Uncaught errors | `switchMic` launches with no `try`, and `openMic` throws when the publish fails, which is likely during a reconnect: the Mic button can crash the app. Any throw while a message is handled ends the process | high |
| Permission loss | A revoke kills the process. Nothing says why. A denied notification permission goes unsaid | low |
| Rotation and process death | The draft and the pairing state go on a rotation. The transcript's notes and the unsent screen log go on a death | low |
| StrictMode and vitals | Neither exists. Play vitals do not apply to a side-loaded app; `getHistoricalProcessExitReasons` does | gap |

Items 1 and 2 below built and landed 24 September 2026 (9c1e5a3). The three
follow-ups landed 24 September 2026 (37bfd3e).

Still to do, in this item:

1. Done (9c1e5a3). On each launch, read `getHistoricalProcessExitReasons` and send those
   records too. It gives ANRs with a thread dump, native crashes, low-memory
   kills and permission kills, which the handler of part 1 misses. That record
   is the only vitals this app can have.
2. Done (9c1e5a3). The one high finding: catch the throw in `switchMic`, set `micOn` only after
   `openMic` succeeds, add a `CoroutineExceptionHandler` to `Bridge.scope` that
   writes the crash file, and put a `try` around each message in `on`, so one
   bad message is dropped and the room goes on.
3. The forced crash on the phone that the done line asks for.

The three follow-ups the finding names, done (37bfd3e): the debug build runs
StrictMode, the three cuts outlive a process death, and the screen log builds
off the main thread.

Done when a forced crash on the phone gives a file in `~/.sidetone/crashes/`
with the stack trace, the exit reasons are sent, and the Mic button cannot end
the process.

### Notes

- 2026-09-29 07:36: Tested live in the days before 29 September 2026, by Chris.

## 40. The app learns of a new build only when it joins the room
---
id: 40
status: done
created: 2026-09-23
updated: 2026-09-29
priority: medium
labels: []
---

Landed 23
September 2026 (3b35cbe, spec 17.15.5, 17.15.6). The bridge looks at the
file every 2 seconds and sends `apk` when the hash changes and two looks
agree. Not yet tried on the phone: a build while in the room, and the button
within about 4 seconds.

### Notes

- 2026-09-29 07:36: Tested live by Chris in the days before 29 September 2026; the 'not yet tried' line above is out of date.

## 41. Voice input after the app was closed for a while
---
id: 41
status: done
created: 2026-09-23
updated: 2026-09-29
priority: medium
labels: []
---

Noted 23 September 2026. Investigated 24 September 2026,
`~/.sidetone/findings/voice-input-41.md`. The background was not the cause. At
12:58 a rejoin left a microphone track in the room that the app did not know
about, and from 13:55 each hold press added a second track. The bridge fed
both into one ear, and the silent dead track stopped every utterance, with no
journal line. Fixed on the bridge in 9c0acd7: the ear hears the newest track of
each participant, and a press that records nothing says so. The app keeps its
cuts across a process death since 37bfd3e, which removes the trigger.

Still to do: reproduce on the phone or an emulator how the track outlived
`closeMic` (tap Mic off within 200 ms of the publish, twenty times, and list
the room's tracks). The finding says the likely path is an unpublish before the
server had the publish. `adb` is at `~/Android/Sdk/platform-tools/adb`.

The text below is the item as it was noted.

At about 13:55 on 23 September the bridge lost the voice of Chris. The journal
showed the phone open and cut its microphone every two to four seconds, and
Chris did not know why. The microphone was cut, and hold-to-talk presses opened
it for a moment. After a restart of the app and the update, input worked again.
The app had been closed or in the background for a while before.

The drive of 23 September was on the media build. Its silent Bluetooth and the
voice that stopped after a media player are explained by item 27: media mode,
and a setup without focus had no route (cd636d6). That is not the fault this
item is about.

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

Three findings of item 39 part 2 are candidate causes: after a process death
the cuts reset and the microphone opens on its own; after a system kill nothing
rejoins until Chris opens the app; and a failed publish from the Mic button
throws. Read `~/.sidetone/findings/stability-39b.md` first.

Done when a test with the app in the background for an hour, then in front
again, gives a working microphone with no touch, or a fix for the cause.

### Notes

- 2026-09-29 07:36: Tested live in the days before 29 September 2026, by Chris.

## 42. The bridge cannot tell which build of the app is running
---
id: 42
status: done
created: 2026-09-23
updated: 2026-09-23
priority: medium
labels: []
---

Landed 23
September 2026 (5ff60c1, spec 14.15). The leftover was bigger than the
message: rtc-node adds the participants already in the room at `connect`
without `ParticipantConnected`, so a restarted bridge sent a phone already
there no `protocol`, `settings` or `history` at all. `device` also names the
audio setup in force since c051f12.

## 43. Words in a chat bubble arrive scrambled on a bad connection
---
id: 43
status: done
created: 2026-09-23
updated: 2026-09-23
priority: medium
labels: []
---

Landed
23 September 2026 (e33ec3c, spec 14.9.2.1). Not the connection: the LiveKit
Android SDK posts each data message on `Dispatchers.Default`, so two sent a
millisecond apart arrive in either order. Four chunks arrived reversed in a
1 ms burst with every character present. Each delta carries `seq`.

## 44. Change more settings without a rebuild or a restart
---
id: 44
status: done
created: 2026-09-28
updated: 2026-09-28
priority: medium
labels: []
---

Closed 28
September 2026. The phone half landed 24 September 2026 (c051f12, spec
18.15): a pushed `setup` message changes the audio setup, and the app
applies it by rejoining the room. The bridge half landed 24 September 2026
(60d137f, spec 9.4.9): `bargeInLevel`, `minSpeechPeak` and
`endOfTurnPauseMs` change from the options screen and reach the live ear.
Chris checked it a few days before 28 September: he changed a bridge
threshold from the menu, and the next turn used it with no restart.

## 45. The status light: smaller, a legend on tap, and the state word never shows
---
id: 45
status: done
created: 2026-09-23
updated: 2026-09-29
priority: medium
labels: []
---

Landed 23 September 2026 (98d96a8, spec 17.11.7). The word never
showed because 17.11.7 withheld it for every state Chris expects, which is
every state that lasts; it now shows in every state. The dot is 26 dp, from
32, and a tap opens the legend. Only the phone can judge the size.

### Notes

- 2026-09-29 07:36: Tested live by Chris in the days before 29 September 2026; the 'not yet tried' line above is out of date.

## 46. Replace the three-dot menu with a gear that opens settings
---
id: 46
status: done
created: 2026-09-23
updated: 2026-09-23
priority: medium
labels: []
---

Landed
23 September 2026 (98d96a8). Same name for a screen reader, opens the menu
of item 28.

## 47. Hold to talk keeps the turn open until the release
---
id: 47
status: done
created: 2026-09-23
updated: 2026-09-23
priority: medium
labels: []
---

Landed 23
September 2026 (9b6861f, spec 9.5.2). `Utterances.held` stops the
end-of-turn pause while the button is down; the test saw two turns before
the change and one after.

## 48. The voice keeps speaking to the end of the sentence after a barge-in or audio off
---
id: 48
status: done
created: 2026-09-23
updated: 2026-09-23
priority: medium
labels: []
---

Landed 23 September 2026 (e72fec5). Both causes were
measured: the LiveKit `AudioSource` holds about 1000 ms, so a cut left 787 ms
playing, now under 500; and "Audio off." waited on the whole queue, so the
held answer played on behind it. `frames()` clears the source on a cut, and
`Mouth.quietAfter` turns the audio off when its own line ends.

## 49. Leaving the room keeps the app open, and one tap rejoins
---
id: 49
status: done
created: 2026-09-28
updated: 2026-09-28
priority: medium
labels: []
---

Closed 28
September 2026 (4d15b13). Takes over what was left of item 27. "Leave" ends
the room and releases the phone's audio, so the car stops treating the phone
as in a call; the app stays open with the conversation and a rejoin control,
and the pairing is kept. "Quit" is in the options screen. The bridge needed
no change. On the phone the music played after Leave, and one tap brought
the conversation back with the history.

## 51. A design pass on the status light and its legend
---
id: 51
status: done
created: 2026-09-28
updated: 2026-09-28
priority: medium
labels: []
---

Closed 28
September 2026 (9df5cc8, spec 17.11). Before, four of the seven states were
amber. The colour now says whether the bridge hears Chris, a slow pulse says
work is in progress, "stalled" is solid red, the ring is gone, and the legend
draws each dot with its pulse. Chris read the light and the legend on the
phone.

## 52. The hold music fades in
---
id: 52
status: done
created: 2026-09-28
updated: 2026-09-28
priority: medium
labels: []
---

Closed 28 September 2026 (e782b4c, spec
15.10.4). Each start of a track, the first and each resume, fades in on a
straight line over `holdMusicFadeInMs`, default 150 ms, where 0 starts at
full level. Chris heard it on the phone.

## 54. End a turn before the 1.5 s pause
---
id: 54
status: open
created: 2026-09-26
updated: 2026-09-26
priority: medium
labels: []
---

Noted 26 September 2026, from the round trip plan of 25 September and the
voice bridge field survey (vault: Voice Bridge Field Survey 2026-09-26). The
plan file is gone; this item holds what is left of it.

The end of turn pause (`endOfTurnPauseMs`, 1,500 ms) is the largest part of
the round trip. A plain shorter pause cuts too many turns: from 19 to 26
September, 278 of 530 utterances (52%) held a quiet of 400 ms or more that
Chris talked through.

Done so far: the Smart Turn v3 detector runs in shadow (f040436, spec 18.16,
`speech/turn_worker.py`). At each tentative end it writes a `turnGuess` line
and ends nothing. The open microphone drive of 27 September added 147 guesses.
The whole record now holds 195: 89 on utterances that ended on a pause, 2 on a
flush, and 104 on pauses that Chris talked through. At 0.5 the detector would
have caught 69 ends and cut 31 of the 104 pauses. At 0.95 it would have caught
48 and cut 17.

### a. Let the detector end a turn

1. Drive with an open microphone until about 100 utterances end on a pause:
   `docs/testing.md` test 16 (fd68793). It also checks the vocabulary prompt
   of b139674. At 89 after 27 September.
2. If a threshold exists with few `cutOff` and most `caught`, add a third
   `turnDetector` value that ends the utterance at the tentative end
   (`endedBy: "detector"`). The pause stays as the backstop.
3. Check that `pauseMs` on the `answered` line is the pause that happened
   (400 ms when the detector ends a turn), not the setting.
4. Drive again and read the round trip.

### b. A retract and join window

From duck_talk. When a turn ends early and Chris goes on talking, retract the
turn and join the two utterances into one. It is the safety net for a short
end in part a, or the alternative if no good threshold exists. Wait for the
shadow data of part a.

Done when the drive of part a gives a verdict, and the chosen part is on
`main` with a drive that shows a shorter pause and no more cut-off turns than
today.

## 55. About a second of the agent's time is not the model
---
id: 55
status: done
created: 2026-09-26
updated: 2026-09-29
priority: medium
labels: []
---

Noted 26 September 2026, from the first word bench (vault: Agent First Word
Bench 2026-09-26, `scripts/first-word.ts`, 8791a00).

On a warm process with the bridge's own arguments, Sonnet 5 gives its first
text delta in 0.62 s at the median. The `agentMs` median from drives is 1.6 s.
`--effort low` and a short `--tools` list change nothing measurable. Haiku is
slower (0.94 s) because it always thinks first. Those levers are closed.

Find where the other second goes. Candidates, none measured: the larger
context of a real session (records show 88k or more cache reads), the note
that the bridge puts in front of a turn, cache misses between consecutive
turns, and turns that start with a tool call. The `answered` line now has the
exact thinking count and the cache counts to split them.

Done when the record splits the median `agentMs` into its parts, and each part
either has a fix or a reason to leave it.

### Outcome, 28 September 2026

Measured from the 123 `answered` lines of 25 to 28 September that have the
stream fields, each matched to its Claude Code session by the time the text
went in. Four probes used the bench's command line on the same afternoon:
scratch copies of `scripts/first-word.ts` with `--resume <id>
--fork-session`, `--effort`, and several processes at once.

The 1.6 s median came from lines of 22 and 23 September, before the stream
fields existed, so it cannot be split. On the lines that can be split, the
median `agentMs` is 4.3 s for all turns and 2.1 s for turns with no tool
before the first word. The tool-first turns (50 of 123, median 10.2 s) move
the median for all turns. The table splits the no-tool turns: 71 turns
under 10 s, mean 2.53 s, median 2.07 s.

| Part | Mean share | Evidence | Fix or reason to leave |
|---|---|---|---|
| Request floor | 0.60 s | `requestMs` in a fast session is 0.5 to 0.7 s, the bench's whole number | Leave. It is the network and the server. |
| Slow session | 0.70 s | See below: some sessions add about 1.2 s to every request | Fork the session when it is slow. See below. |
| Thinking | about 1.2 s | 41 of 73 no-tool turns think. Each thinking token costs 11 ms (fit over those 41 turns). The median is 75 tokens | A setting for `--effort`, then a drive with `medium`. See below. |
| The bridge and Claude Code before the request, and `message_start` to the first delta | 0.07 s median | `agentMs - requestMs` on turns with no thinking | Leave. This includes the note in front of the turn: `voiceInstruction` is in the cached system prompt, and the verbosity line is about 30 tokens. |
| Context size | none | In a fast session, a fork at 128k tokens answers in 0.68 s against 0.6 s at 40k. The record shows fast sessions at 85k | Leave. |
| Cache misses | none | Cache creation median is 280 tokens. The 6 no-tool turns that wrote more than 2k tokens took 1.2 to 2.6 s | Leave. |

`requestMs` is the time from the `requesting` status to `message_start`. On
the turns that start with text, it is all but 70 ms of `agentMs`.

**Slow sessions.** `requestMs` depends on the session, not on the context or
the hour. Four of the eight bridge sessions had a median of 0.58 to 0.70 s.
The other four had 1.5 to 2.4 s. The slowest session was 6df73db9: 50 turns
over two hours, and no request under 1.2 s. The probes show that the server
keys the delay to the session id:

| Probe, turns interleaved | `requestMs` median |
|---|---|
| A copy of slow session 79c65674, resumed under its own id | 1.57 s (1.40 to 2.40) |
| A fork of the same transcript, which gets a new id | 0.57 s (0.51 to 0.73) |
| 13 new sessions, 3 to 16 turns each | 2 slow (1.49 s, 1.75 s), 11 fast (0.53 to 0.74 s) |

The fork has the same context and reads the same cache, so it costs no cache
write. The proposed fix: when the first three requests of a session each take
more than 1.2 s, the bridge starts the agent again with `--resume <id>
--fork-session`, between turns. This is behaviour of the server, not a
contract, so a drive has to show that it holds. Saves about 1.2 s per turn in
about half of the sessions.

**Thinking.** The bench prompts never thought, so its `--effort low` result
did not test thinking. Real turns think in 56% of the no-tool turns. On six
real voice prompts sent to a fork of 79c65674 (two rounds, and out of their
context, so they thought more than in the car), thinking tokens were:

| Effort | Thinking tokens, total | Median | Change |
|---|---|---|---|
| high (the default) | 12,292 | 721 | |
| medium | 6,321 | 359 | -49% |
| low | 3,873 | 251 | -68% |

The proposed fix: an `effort` setting passed to `claude`, and a drive with
`medium`, which checks the answers as well as the time. At 11 ms a token,
`medium` saves about 0.6 s of the 1.2 s mean. This probe did not judge answer
quality.

**Tool-first turns.** Item 63a closes these: one sentence before the first
tool call takes the tool time off `agentMs`. In Langfuse, the time from the
end of a model call to the start of its tool is 0.48 s median (p90 2.9 s,
104 calls in sessions 79c65674 and 6df73db9). This time is before the tool
runs, and nothing explains it yet. It is a follow-up, not part of this item.

### Notes

- 2026-09-29 13:19: 29 Sep: Chris agreed to both fixes. Job agent-settings adds the model and effort settings (drive with medium checks answer quality). Job fork-slow builds the session fork.
- 2026-09-29 13:49: job agent-settings landed as 0bcf36a

## 56. Can correct audio arrive distorted from the connection or the transport?
---
id: 56
status: done
created: 2026-09-28
updated: 2026-09-28
priority: medium
labels: []
---

Closed 28 September 2026 (cee9eb2) with the finding
`~/.sidetone/findings/audio-transport-56.md`, from the code and the journal.
Yes: loss and jitter on the cellular link, concealed by the phone's jitter
buffer, can garble a correct render. The measurement landed the same day
(309d2fe, spec 14.17): the app sends its receive statistics every 5 s while
the bridge speaks, and the screen log has a `reconnect` event. No fix made.

## 57. Say what a long check does before each step, not only the first
---
id: 57
status: done
created: 2026-09-27
updated: 2026-09-27
priority: medium
labels: []
---

Closed 27 September 2026 as a rule in `CLAUDE.md`, under the spoken
conversation. No code: it is the agent's habit in a spoken turn.

## 58. The gate does not see a command piped into a shell
---
id: 58
status: done
created: 2026-09-28
updated: 2026-09-28
priority: medium
labels: []
---

Closed 28
September 2026 (spec 10.7.6). A shell with no `-c` and no script file, or
with `-s`, reads a pipe or a redirect, so `gatedAction` gates it as a
command that the bridge cannot read. A shell that names a script file still
passes: the bridge does not read the file.

## 59. Send screenshots over HTTP, not the control channel
---
id: 59
status: done
created: 2026-09-28
updated: 2026-09-28
priority: medium
labels: []
---

Closed 28
September 2026 with a measurement; the change is not kept. A branch had
the app POST the JPEG whole to `/screenshot`, with the room token as the
pass, and kept only the drop and the states of 14.12.7 on the control
channel. `scripts/screenshot-link.ts` measures both ways: two rtc-node
participants and a private LiveKit server, a real 53 KB screenshot sent
3 s into a stream of deltas, with netem on the phone's link. The delay of
the deltas after the send starts:

| Link (up/down, one way, loss) | Parts: max | HTTP: max |
| --- | --- | --- |
| 256k/1M, 50 ms, 0% (3 runs each) | 54-71 ms | 54-59 ms |
| 128k/512k, 100 ms, 0% (3 each) | 183-225 ms | 322-1,245 ms |
| 64k/256k, 150 ms, 1% (6 each) | 0.5-6.5 s; 0-206 deltas over 1 s | 4.5-5.1 s; 116-135 over 1 s |

The base delay is the netem delay. The cause is the phone's full uplink
queue, which delays the acknowledgements of the downlink, not the control
channel: a data message the phone sends does not queue in front of one it
receives. A POST fills the same uplink, and TCP fills it harder. The change
does not cut the delay and adds a route on the tailnet that needs a token,
so the screenshot stays in parts on the control channel. Not measured on
the phone itself or on a real mobile link.

## 60. Set the level for speech from the noise in the car
---
id: 60
status: open
created: 2026-09-27
updated: 2026-09-27
priority: medium
labels: []
---

Noted 27 September 2026, from the architectural review of 25 September
(section 7, long term). The levels that decide speech, `speechLevel` and
`bargeInLevel` in `src/config.ts`, are fixed numbers. The
review proposes that the bridge measure the noise when nobody speaks and set
the level from it. Done when the record of a drive shows whether the
noise changes enough between roads to need this: the level of the quiet
frames, over one drive, by minute.

## 61. `/play` says it plays a file and then drops it
---
id: 61
status: done
created: 2026-09-27
updated: 2026-09-29
priority: medium
labels: []
---

Noted 27 September 2026, from `docs/testing.md` test 15 in the car (vault: Voice
Bridge Car Test 4). The test failed.

At 11:36 the agent asked `/play` for a hold track (Soulful Strut). The route
answered 202 and the record has a `track` event for the file. The track
stopped after 26 s with `"whole": false`, so it did not play to the end.

A second `/play` call asked for the short kept clip `interrupting-on.wav`. The
route answered 202, and the journal says `[playing ... when the mouth is
free]`. The record has no `track` event for it, so the clip never played.
Chris heard a burst of hold music in its place.

So `/play` can report success and drop the request (`src/routes.ts`,
`Mouth.play`). The tests of 15.12 in `test/turn.test.ts` pass.

The second clip is fixed. `Mouth.play` took the track off its queue before
`speaker.track` answered, and the hold music held the source, so the track
was lost. Now a refused track stays first in the queue, and a waiting track
fades the hold music out and keeps it from starting. Two tests in
`test/turn.test.ts` hold it (item 61).

The first track was not a fault. The record has a `barged` line at
11:36:41.558, 14 ms before the track stopped: Chris asked for "a shorter
one", and his speech cut the track as 15.10.3 says.

Done when `docs/testing.md` test 15 passes in the car: the track and the
sentence both play in full, with a `track` event for the file that says it
finished.

### Notes

- 2026-09-29 07:36: Tested live in the days before 29 September 2026, by Chris.

## 62. Investigate batching for Sidetone's own tool calls
---
id: 62
status: done
created: 2026-09-28
updated: 2026-09-28
priority: medium
labels: []
---

Closed 28
September 2026 (7ae9476, the measurement; 94bbe0a, the line). Batching saves
one model step, about 3 s, in about 6% of voice turns, at most 9%, and seldom
moves the first word. Nothing in Sidetone orders tool calls; Claude Code
already runs the calls of one step together. The one lever is a sentence in
`voiceInstruction`: "Run lookups that do not depend on each other in one
step." Item 63a covers the turn that calls tools before it speaks.

## 63. Strengthen two rules in the voice instruction
---
id: 63
status: done
created: 2026-09-28
updated: 2026-09-29
priority: medium
labels: []
---

Noted 28 September 2026, from a live conversation where both were broken.
The agent called a tool with no sentence first, so the voice went silent
while it ran, despite `voiceInstruction` in `src/config.ts` already saying
to speak first. Separately, asked about round-trip data, it guessed an
answer instead of reading `~/.sidetone/record.jsonl`, and was wrong.

Both rules are now in `voiceInstruction` and in spec 6.6.3 and 6.6.4. What
is left is to see whether the model follows them.

### a. Say something before every tool call

The record already had the check: `toolsBeforeText` on each `answered` line
(18.4.1). Before the change, 64 of 176 turns that record it called a tool
before the first word; 28 of 82 in the last 24 hours. Most of them thought
first (`firstEvent` "thinking"), then called the tool.

Why the old rule was skipped, from its wording: "Begin every answer" read as
what comes after a lookup; the tool rule gave no reason, and lost to the
global instructions "no preamble" and "when a lookup is needed, do it"; and
the rule was split over the sixth and ninth of thirteen lines. The new rule
is third, names the tool call, gives the reason (the voice is silent until
the first sentence), and says it overrides an instruction to skip a preamble.

A cold A/B did not reproduce the fault: six lookup questions, twice each,
`claude -p` on sonnet in `~/sidetone` with the old and the new instruction,
gave 0 of 12 silent starts for each. In the record, silent starts are 27% of
turns under 50k tokens of cache and about 40% above, so a long session makes
them more likely but does not explain them. Only live use can judge the new
wording.

The scorecard counts silent starts (spec 18.17). `bun scripts/session-check.ts
brief` puts the count in the journal line and flags any.

Done when a day of spoken use gives a silent-start count well under the 36%
of before, in `bun scripts/session-check.ts brief 24h`.

### b. Do not guess at stats, logs or other facts a file would settle

A new line tells the agent to read the source first (the record, the
journal, the project's files, the git log) and to say it does not know when
none settles it. No code can check this: a guess and a read answer look the
same in the record. It stays a matter of the model's adherence. In the same
A/B, all 24 turns read a source before they answered, with either wording.

Done when a question about the record, asked by voice, gets a tool call that
reads it before the answer.

### Notes

- 2026-09-29 07:36: Tested live in the days before 29 September 2026, by Chris.

## 64. Push small, independent tasks to a background job
---
id: 64
status: done
created: 2026-09-28
updated: 2026-09-29
priority: medium
labels: []
---

Closed 28
September 2026. A rule in `CLAUDE.md`, under "Jobs in a spoken
conversation", sends a small, independent task to `aleph job` and keeps a
question Chris waits on inline. It defines "small" as a bounded, mechanical
edit or lookup, and "independent" as a result that nothing later in the
turn needs. Chris rescinded the small-task half on 28 September 2026: a
small edit or lookup is done inline again, and a job is for exploration,
research or a build. Not yet tried in the car since the rule.

### Notes

- 2026-09-29 07:36: Tested live by Chris in the days before 29 September 2026; the 'not yet tried' line above is out of date.

## 65. A Sidetone command for the twelve-phrase model check
---
id: 65
status: done
created: 2026-09-28
updated: 2026-09-29
priority: medium
labels: []
---

Landed 28
September 2026 (90b13c0, spec 9.4.15). "sidetone, read the card" mutes, says
each line of test 17's card for Chris to say after it, three rounds, then
unmutes. The next line waits for his utterance, not a timer, so a lost line
is said again. The card keeps the heard clips while it runs, with no
`keepHeardClips` flag, and the journal names the line each utterance
answered, which labels the clips. Only "unmute" acts on the card, and stops
it. On the card an echo is only what began while the voice played: Chris
repeats the line within a second of its end, which the usual 1 s grace
would drop. Not yet tried in the car.

### Notes

- 2026-09-29 07:36: Tested live by Chris in the days before 29 September 2026; the 'not yet tried' line above is out of date.

## 66. Say something when the service restarts
---
id: 66
status: done
created: 2026-09-28
updated: 2026-09-29
priority: medium
labels: []
---

Closed 28 September 2026
(spec 14.16.4). A new process of the bridge says "Sidetone started." once,
when its workers are warm and a client is in the room, or when the first
client joins after that. It is spoken, not a cue, so `tones off` leaves it
on. The tests cover the timing; Chris has not heard it in the room yet.

### Notes

- 2026-09-29 07:36: Tested live by Chris in the days before 29 September 2026; the 'not yet tried' line above is out of date.

## 72. Keep the session context across a service restart
---
id: 72
status: open
created: 2026-09-28
updated: 2026-09-29
priority: medium
labels: []
---

Noted 28 September 2026, after the service restarted and Chris asked what
happened. Each start of the service begins a new `claude -p` session with no
context. Chris wants a restart to keep the context, with the existing
`/aleph:handoff` and `/aleph:pickup` skills: a handoff before the session
stops, and a pickup when the new one starts.

Two places would hold the hooks. The SIGTERM handler in `src/serve.ts` leaves
the room and exits; a handoff turn would run there, before `bridge.stop()`,
or as an `ExecStop=` in `~/.config/systemd/user/sidetone.service`. A pickup
would be the first message the bridge sends to the new session. A crash or a
restart after `StartLimitBurst` gets no handoff, and a handoff turn can take
longer than systemd waits for a stop.

Open questions: do two skills built for an interactive session make sense
for a `claude -p` process under systemd? Is `--resume` with the last session
id a simpler way to keep the context? Restarts are rare, so is the lost
context a real cost?

Done when there is a decision on whether to keep the context across a
restart and how, or the item is dropped with a reason.

### Notes

- 2026-09-29 00:52: Renumbered from 67 to 72; 67 was taken by the transcription card item, which has 67b sub-parts in b4eda34 and 77a7a74. Commit e1821cf calls this item 67.
- 2026-09-29 11:49: Checked the skills 29 September. Changed in aleph: /aleph:handoff and /aleph:pickup take an optional name (the bridge uses sidetone), so the bridge file is ~/.aleph/handoffs/sidetone.md and cannot collide with a typed session; with a name the handoff ends with 'Handoff saved to <path>.' and no /clear line. The handoff must run as a turn in the live session, because it writes from the conversation. ExecStop= cannot do it; the SIGTERM handler in src/serve.ts must send the turn and wait inside systemd's stop timeout.
- 2026-09-29 11:56: Built on job/restart-context 29 September: keepContext (default true); SIGTERM leaves the room, then a quiet turn /aleph:handoff sidetone with a 150 s limit; a start sends /aleph:pickup sidetone when ~/.aleph/handoffs/sidetone.md exists; a running turn is interrupted first; TimeoutStopSec=180 (installed unit updated). Spec 8.12. Tests in test/bridge.test.ts. Checked: claude -p on stream-json runs /aleph:pickup <name>. Manual check left: restart the service, then ask what we were talking about.

## 67. The card gets ahead of Chris, and a card of plain sentences
---
id: 67
status: dropped
created: 2026-09-28
updated: 2026-09-29
priority: medium
labels: []
---

Noted 28 September 2026, from the first read of the card (item 65) in the
car, 16:06 to 16:10.

### a. One split utterance moves the card one line ahead

Chris heard the card say the next line before he had said the last one, late
in round 1. The journal shows the cause. `readLine` in `src/conversation.ts`
takes every utterance as the whole answer to the line, and says the next
line at once. No timer and no echo drop are in it. When the ear ends an
utterance on a pause in the middle of a line, the first part answers the
line and the second part answers the next one, so the card is one line ahead
of Chris for the rest of the round:

| Line said | Heard | Speech in it |
|---|---|---|
| 4 female voice | "site." | 0.1 s |
| 5 carry on | "Sidetone, female voice" | 0.8 s, 0.2 s quiet before |
| 7 recap | "Sidetone" | 0.3 s |
| 8 stats | "Say again." | 0.4 s, 0.3 s quiet before |

After line 7 the card was two lines ahead. Chris's aside at line 10 ("hold
up, hold up ... work the test") answered line 10, and he caught up at line 11.
Rounds 2 and 3 had no split and kept pace. The echo drop (18.10.1) dropped
nothing in the run. The labels of round 1, lines 4 to 10, are wrong for the
scoring of test 17: fix them by hand from the heard texts.

"Sidetone" at line 7 is the ear ending the turn on the pause after the wake
word. What "site." at line 4 was is open: 0.1 s of speech, a false start or a
noise.

Open: how the card knows an utterance is the whole line. Candidates: say the
line again when the heard text does not match it (`match`), join a short
utterance to the next one, or wait longer for the end of speech while the
card runs. Done when a card read in the car has no line answered by part of
another.

### b. A card of plain sentences

Eleven of the twelve lines of test 17 are "sidetone, ..." commands, so the
card mostly tests how each model hears the wake word. Chris wants a second
card of ordinary sentences, so the check also scores plain speech. Open: the
sentences, and how the command picks the card ("read the plain card", or a
setting). The sentences should be like what Chris says to the agent in the
car: file names, numbers, project words and a question or two. Done when
"read the card" can read either card, and test 17 scores both.

#### Findings, 28 September

Sources: the 943 utterances with words in `~/.sidetone/record.jsonl`, the card
read of 16:06 to 16:10, and the vocabulary prompt (`sttVocabulary`, since 26
September).

- The command card spends most of its words on "sidetone". The drive's reads
  of it were right but for the wake word: "Saitone", "Cytone" and "site." on
  28 September, with the prompt in force.
- The record's misses are names: "Claude" as "Cloud" and "Clod", "Sidetone"
  as "inside tone", "SITONE", "Sight tone", "worktree" as "work tree". All
  are in the prompt now; the plain card measures whether the prompt holds.
- Words out of the prompt are not measured anywhere: "ADR", "APK", "Whisper",
  file names ("echo check.ts" in the record), code names.
- Numbers come back as digits or as words by chance ("five or 10"), so a
  line with a number tests the form the agent reads.
- Chris talks to the agent in commands ("land it", "drop it", "restart the
  service") and questions ("What whisper model are we running right now?"),
  from two words to thirty.
- A synthetic read of the plain card on small.en (two Kokoro voices, clean)
  already misses "car cue" ("Car Queue"), "plain card" ("plane car") and
  "readLine" ("read line"), and writes "conversation.ts" as "conversation,
  TS". The lines separate models before Chris's voice is in them.
- The same engine wrote "read the plain card" as "read the playing card" in
  every take of the corpus, so "playing" is a form of the command.

The twelve lines and the reason for each are in test 17 of `docs/testing.md`.
A speech line scores as right when its letters and digits match the line's,
lower case.

On 28 September Chris renamed the plain card the transcription card and
dropped the command card. The transcription card is the one card of test 17:
the twelve sentences, then three "sidetone, ..." commands ("end the turn",
"male voice", "recap"), because the command card was the only part of test 17
that scored the wake word. "read the card" and "read the transcription card"
both read it (spec 9.4.15), and "read the plain card" is gone.

### Notes

- 2026-09-29 08:13: Superseded by item 71.

## 69. A blip of garbled speech at the start or the end of an answer
---
id: 69
status: done
created: 2026-09-28
updated: 2026-09-29
priority: medium
labels: []
---

Noted 28 September 2026, from Chris in the car at 16:12 (record, `heard` at
1790637127671). In his words: "there are these moments where it's like this
syllable comes out of the text to speech, like, I don't know if it's like out
of order, or it's like, it's or backwards, or it sounds like really, really
weird. It's like an interjection. It happens every once in a while." And:
"Usually at the beginning of a response, or maybe at the end, but never in the
middle, really." He thought it may be a connection glitch. It is intermittent,
and no report names a time yet.

### What the telemetry of that drive shows

The drive ran from 16:02 (the `device` line with route Audi MMI) to 16:13.
Most of it was the card of item 65: short lines, each one its own clip.

- No transport data. The phone runs the APK built 27 September at 07:42
  (`ab234707a15a`, and the bridge serves the same file). The receive
  statistics and the `reconnect` event of 14.17 landed on 28 September at
  10:47 (309d2fe), so this build sends neither. The journal of the day has no
  "the phone received" line, and the screen log has no `reconnect`. The drive
  has no "the phone reports poor" line either, but that reading is coarse.
- The render has faults at the edges. The drive's 55 kept clips
  (`~/.sidetone/sent/`) were copied to `~/.sidetone/findings/blip-69/sent/`
  before they rotate out. The speech worker transcribed each one against its
  text, as `bun scripts/sent-check.ts` does. Five are garbled, all at the
  start or the end of the clip, none in the middle:

  | Time | Text | Heard |
  |------|------|-------|
  | 16:05:53 | `Listening."` | "Living Eik." |
  | 16:06:05 | "Round 1." | "Oh, wow, yep." |
  | 16:06:28 | "sidetone, female voice." | "Sidetone, female voice, Nabei" |
  | 16:08:02 | "sidetone, stats." | "Cytone, Stats" |
  | 16:08:16 | "sidetone, interrupt on." | "Cytone Interrupt on" |

  A sixth, "Logging that one too" at 16:12:20, came back as "Log in at 1.2",
  at the start of an answer. It passed the likeness check.

  The first two are the fault of item 33: chatterbox garbles one-word text.
  "Listening." is one word because the splitter cut the agent's `says "That
  is the card. Listening."` at the period inside the quote. The third has an
  extra syllable after the last word. The last two smear the first syllable.
  These faults are in the wav that the bridge sent, so the render makes them,
  not the connection. Nobody has listened to the clips yet; the transcriber
  can mishear a short clip too.
- The cues do not mix into the speech. The room has one audio source, and
  `speak` in `src/transport.ts` writes one wav at a time, so the frames of a
  cue and of a sentence never interleave. A cue can play right before the
  first sentence (`thinking`) or right after the last (`done`, 15.15), and
  `Mouth.cue` drops a cue while a sentence plays. A click next to a word can
  sound like part of the word, but it is not in the word's samples.
- No note in the research of item 5 or 56 names an onset fault of chatterbox.

So the drive has a likely cause for some reports, a render fault on short
text and at the edges of a clip, and no data to rule transport in or out.

### What the takes show, and what changed

Measured 28 September, after the drive. The speech worker transcribed the 55
kept clips again: the same five are garbled. Each text was then made 20 times
with the drive's voice and checked the same way:

| Text | Garbled alone | Garbled in the form now sent |
|------|---------------|------------------------------|
| `Listening."` | 17 of 20 | 0 of 20, inside its whole sentence |
| "Round 1." | 7 of 20 | 2 of 60, with the first line of the round |
| "sidetone, female voice." | 0 of 20 | 0 of 20, checked |
| "sidetone, stats." | 4 of 20 | 1 of 20, checked |
| "sidetone, interrupt on." | 0 of 20 | 0 of 20, checked |
| "Added." | 19 of 20 | 1 of 20, as "Added. It's item 70 in the todo file." |
| "Okay." | 16 of 20 | 0 of 20, as "Okay. I'll check tonight's logs." |

The cause is the length of the text. The cloning voice garbles a clip of one
word most of the time and a clip of two words often; three words and more
were clean in 40 fresh takes, though the drive had two bad takes of three.
The same text is clean in one take and garbled in the next: "sidetone,
stats." was garbled in round 2 only. It is not the lower-case first letter
(chatterbox makes it upper case) and not the connection. The record has 99
spoken sentences of one word and 141 of two, so the agent makes such clips
too, often at the start of an answer, which is where Chris hears the blip.

Three changes:

- The splitter does not cut at a full stop inside a quotation (spec 5.6.1).
- A sentence of one or two words joins the sentence after it (spec 5.6.2).
  The card says "Round N." in the clip of the first line (9.4.15).
- A made sentence of four words or fewer is checked by the speech worker
  before it plays, and made once more when the check refuses it (spec
  11.6.5). The journal says "the voice garbled ...; it is made again".

Not fixed: a short sentence alone at the end of a text block, such as one
before a tool call, still goes alone, and one more take does not save a word
the voice nearly always garbles ("Listening." alone still played garbled in
11 of 20). "Logging that one too" at 16:12:20 ("Log in at 1.2") passed the
check at 0.82 and is not caught. None of this is tried in the car yet.

### What to capture next time

1. Install the current APK on the phone before the next drive, so the app
   sends its receive statistics (14.17) and logs `reconnect`.
2. When the blip happens, say "blip" at once, as a plain utterance. The
   `heard` line of the record then marks the time, and the sentence just
   before it is the one with the blip.
3. Look within the hour. The bridge keeps only the last 100 clips
   (`SENT_KEPT` in `src/sent.ts`), and the card made 55 in ten minutes. Copy
   the clips near the mark, then run `bun scripts/sent-check.ts` on them.
   Garbled in the clip means the render. Clean in the clip, with concealment
   in the journal's receive line at that time, means the connection.
4. If the clip is clean and the receive line is too, suspect the car's
   Bluetooth link (item 56, finding row 4) or a cue next to the word.

Done when one report with a time is matched to its clip and its receive line,
and the cause is named.

### Notes

- 2026-09-29 07:36: Tested live in the days before 29 September 2026, by Chris.

## 70. The hold music fades the wrong way round
---
id: 70
status: open
created: 2026-09-28
updated: 2026-09-29
priority: medium
labels: []
---

Noted 28 September 2026. Chris hears each start of a hold track come in loud
and then get softer. Item 52 (e782b4c, spec 15.10.4) says the opposite: each
start, the first and each resume, rises from nothing to its level over
`holdMusicFadeInMs` (default 150 ms). Nobody has looked into it yet.

Places to check:

- The gain and the fade in the bridge. `wavFromFile` in `src/audio.ts` decodes
  a track at `holdMusicGain` (read on each start, item 28), and `fadeIn` ramps
  a copy of the samples before `Mouth.music` gives them to `speaker.track`.
  The fade out of 15.10.2 (`fadeOut` in `src/transport.ts`, `holdMusicFadeMs`)
  must start only when a sentence stops the track, not at its start.
- The phone's audio path. `Audio.kt` plays the bridge's audio as a voice
  call (`MODE_IN_COMMUNICATION`, `USAGE_VOICE_COMMUNICATION`), and the car
  takes it over Bluetooth. A gain control on the phone, in WebRTC or in the
  car can let the first loud frames through and then turn the level down.

Done when a start of a hold track rises from quiet to its level, seen in the
car or in a recorded sample.

### Notes

- 2026-09-29 08:15: 29 September 2026, job fade-inverse. The bridge output is correct. A scratch run sent a real track (Summer Madness, gain 0.4, 48 kHz) through wavFromFile, fadeIn, encodeWav, decodeWav, resample and frameAt, as Mouth.music and Transport.frames do. RMS in 50 ms windows, first start: 0.0000, 0.0005, 0.0068, 0.0152, then 0.009 to 0.015 to 2 s. Resume at 30 s: 0.0055, 0.0152, 0.0586, 0.0681, then 0.03 to 0.08, the track's own level. Past 150 ms each window equals the track's own. The fade out of 15.10.2 does not start, because Mouth.music starts a track only when nothing is busy. Nothing falls after the start in the bridge. Second finding: five of the eight tracks open with 200 to 650 ms of silence (Let It Flow 650, Soulful Strut 550, Meditation 500, Feels So Good 300, Songbird 200). On a first start the 150 ms fade falls on the silence, and the music enters at full level. Likely cause downstream: a gain control on the received audio, in the car's hands-free unit or in the phone's call-mode downlink. It raises its gain through the silence, lets the first loud frames through, then turns the level down over about a second. The WebRTC gain control in Audio.kt acts on the microphone only, not on the received audio. Proposed fix, not built: (1) start the fade at the first sound of the track, not at sample 0, by skipping leading silence below about 0.003 RMS; (2) make holdMusicFadeInMs about 1500, so the level rises slower than the gain control falls. Checks before the build: set holdMusicFadeInMs to 1500 in ~/.sidetone/config.json, restart the bridge, and listen in the car; then listen on the phone's own speaker without the car. If it rises on the phone and falls in the car, the car causes it.
- 2026-09-29 09:22: 29 September 2026, job fade-inverse, second run. The transport does not cause it either. scripts/hold-level.ts (7e12bfa) plays Summer Madness through a real Mouth.music and a real Transport in a room of its own, and a second Transport receives it as the phone does. Received RMS equals sent RMS to within the codec's error, for the first start (0.0000, 0.0005, 0.0060, 0.0146, then 0.009 to 0.015) and for a resume (0.0086, 0.0200, 0.0282, 0.0334, then the track's own 0.02 to 0.07). No window falls after the start in the bridge or on the wire. So the cause is after the transport: the phone's call-mode playback (VoIP downlink processing in the audio HAL under MODE_IN_COMMUNICATION) or the car's hands-free unit (downlink gain control or noise suppression, which takes steady music for noise and turns it down over about a second). The WebRTC gain control in Audio.kt acts on the microphone only. Also, a 150 ms rise is too short to hear as a rise; it is heard as the onset. Proposed fix, not built: skip leading silence below about 0.003 RMS before the fade, and make holdMusicFadeInMs about 1500 so the level rises slower than a downstream gain control falls. The phone's audio setup stays as it is (item 26). Desk test: (1) Restart the bridge, so the first hold track is the first in file-name order, Feels So Good. (2) Phone on the desk, Bluetooth off, the app on its loudspeaker, call volume at the middle. Laptop microphone 30 cm from the phone, the room quiet. (3) Say: run sleep 40 in the shell, then tell me it finished. (4) When the bridge stops speaking, start Windows Sound Recorder; the music starts about 8 s later. Stop the recording 5 s after the music starts. (5) Run: bun scripts/hold-level.ts --wav '/mnt/c/Users/<you>/Documents/Sound recordings/<file>.m4a' --track 'Feels So Good'. The ratio column is the recording over what the bridge sends, scaled to a median of 1. A ratio that stays near 1 means the phone plays the start as sent, and the car causes it. A ratio that starts high and falls through the first second means the phone's call-mode path causes it. For a check in the car, set holdMusicFadeInMs to 1500 in ~/.sidetone/config.json and restart the bridge.
- 2026-09-29 11:10: 29 September 2026, job fade-skip. Built the proposed fix, not yet heard in the car. firstSound in src/mouth.ts skips the leading silence of each start (10 ms blocks at or below 0.003 RMS at the track's own level, so 0.0012 at gain 0.4), and the fade in starts at the first sound. The resume position counts from there. The default holdMusicFadeInMs is now 1500 (spec 15.10.4). scripts/hold-level.ts --track 'Let It Flow' --stop 10 (650 ms of silence in the file): the first start sends 0.0009, 0.0020, 0.0024, 0.0031, 0.0039, 0.0047 in the first 300 ms and rises to the track's own level by 1.5 s. Before, the first 650 ms were silence and the music entered at full level. Received equals sent within the codec's error. The script now sets audio true in its own Mouth, because the live config's audio false kept the track from starting. Open: the car check. Restart the bridge, remove any holdMusicFadeInMs from ~/.sidetone/config.json, and listen to the first start.

## 71. Look at how the transcription card works
---
id: 71
status: done
created: 2026-09-28
updated: 2026-09-29
priority: medium
labels: []
---

Noted 28 September 2026, after a read of the card at 16:47 that Chris took
for a broken bridge. After a restart, "sidetone, read the card" started the
card. From then on, the card took each thing Chris said as a line, and the
next line sounded like an answer. "Something is very seriously wrong with
the bridge, right?" got "Ask Claude to build the APK and run bun test."

| Time | What Chris said | The line the card read next |
|---|---|---|
| 16:47:36 | "I'm sorry, no, I want to run the transcription test" | "What does item 67 say?" |
| 16:50:42 | "Did we just have an issue with the service?…" | "Check the worktree for changes before you rebase onto main." |
| 16:50:57 | "Something is very seriously wrong with the bridge, right?" | "Ask Claude to build the APK and run bun test." |

Three things to look at:

- **No way out that Chris can find.** On the card, every utterance except
  "sidetone, unmute" is a line (`src/conversation.ts:331`), and nothing says
  the card is still running. Stop the card on any wake command, or on an
  utterance far from its line?
- **Held speech resumes inside the card.** A barge-in held the agent's
  sentence, and the card said it after line 1, so it sounded like a line.
  The card start should drop the held speech.
- **Five empty transcripts, 16:53 to 16:56.** Up to 8.4 s of speech each,
  all from the early guess in 0 ms. The cause is not known.

The vault note is "The Transcription Card Takes Every Utterance Until
Unmute".

Done when each of the three has a fix or a reason to leave it.

### Notes

- 2026-09-29 10:59: Closed at Chris's request on 29 September after the card ran and whisper-scores landed. The three findings were not changed in code; unmute is still the only way out.

## 73. Switch sttModel to medium.en (5.3% word error rate vs 8.2% for small.en) and check it in the car; see docs/whisper-scores.md on job/whisper-scores
---
id: 73
status: open
created: 2026-09-29
updated: 2026-09-29
priority: medium
labels: [stt, voice]
---

### Notes

- 2026-09-29 11:09: Default switched to medium.en on job/medium-model. Measured 29 Sep through LocalWhisper on the RTX 5070: worker start (load + warmup) 4367 ms, warmup 0.02 s (it warms on silence, item 74). Last 10 clips in ~/.sidetone/heard: first decode 825 ms, then 176-341 ms, median 255 ms, worst 825 ms. SIDETONE_GPU=1 bun test speech.smoke: 10 pass. bun test: 977 pass, 0 fail. The car check stays open.

## 74. Warm the STT worker up on speech, not silence: vad_filter removes the silence, so the first utterance after a restart pays 330-770 ms
---
id: 74
status: open
created: 2026-09-29
updated: 2026-09-29
priority: medium
labels: [stt, latency]
---

### Notes

- 2026-09-29 11:09: Measured 29 September 2026, small.en on the card, 6 worker restarts, 12 clips from ~/.sidetone/heard. Each restart sends clip X, clip Y, X again, Y again; the penalty is X first minus X again. Before (warmup on silence with vad_filter=True): the warmup took 0.03 s and did no GPU work; cuBLAS was not even loaded. First utterance 612-804 ms, the same clip again 99-229 ms, penalty 498-575 ms, median 543 ms. After (warmup with vad_filter=False, word_timestamps=True and the initial prompt): the warmup takes 0.53-0.67 s. First utterance 139-274 ms, the same clip again 94-203 ms, penalty 21-71 ms, median 50 ms. A second warmup through a wav file cut the median to 34 ms, inside the noise, so it is not in.

## 75. Delete the scored clips in ~/.sidetone/heard/ once whisper-scores is landed, as test 17 says
---
id: 75
status: dropped
created: 2026-09-29
updated: 2026-09-29
priority: medium
labels: [stt, privacy]
---

### Notes

- 2026-09-29 10:58: Chris keeps the clips in ~/.sidetone/heard/ for future use

## 76. A separate verbosity level for job news and other notifications
---
id: 76
status: open
created: 2026-09-29
updated: 2026-09-29
priority: medium
labels: [voice, design]
---

### Notes

- 2026-09-29 11:52: Noted 29 September 2026. Chris wants the verbosity of job news and similar notifications set apart from the verbosity of answers. To design later.

## 77. Project switching: Chris says 'switch to project X' and the agent applies that project's context to every later turn until he switches again. Needs design: how the bridge stores the active project, and how it differs from per-message context.
---
id: 77
status: open
created: 2026-09-29
updated: 2026-09-29
priority: medium
labels: [design]
---

## 78. File preview in the app: when the agent talks about a file (for example a CLAUDE.md to pare down), the app shows that file on screen so Chris can read it while he listens. Needs design: how the agent names the file to show, how the bridge sends it, and how the app renders it.
---
id: 78
status: open
created: 2026-09-29
updated: 2026-09-29
priority: medium
labels: [design, app]
---

### Notes

- 2026-09-29 13:48: Plan: the agent runs a command 'sidetone show <path>'; the bridge reads the file and sends the app a show message. Markdown and text render inline with Markdown.kt. A PDF is served by the bridge over HTTP and rendered with PdfRenderer. Each file shows as a card in the conversation, and a tap opens a full-screen viewer with pinch zoom, pan and page scroll. Read only. Images and editing are out of scope.
