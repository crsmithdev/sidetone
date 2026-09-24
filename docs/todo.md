# To do

Chris's list of things to build or look at. Add to the end. When an item ships,
move it to the Done section at the end as one line, and say where in the commit
message. [`docs/drive.md`](drive.md) holds the open car tests; this file holds
the rest. Item numbers never change: commits, the spec and the vault quote them.

## 4. Long jobs and the subagent interrupt

Noted 21 September 2026. Part b, a setup for long jobs, is done and deleted.
Part a waits for Chris to decide.

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

So a subagent does not survive an interrupt. Background `Bash` survives it. The
workaround is in `CLAUDE.md` since 23 September (eea4839): long work runs
detached with `scripts/job`, never as a subagent. The bridge speaks a `result`
that arrives with no question in front of it (`Conversation.unprompted`).

The interrupt has a second cost, found under item 38: a barge-in during a
`scripts/job` tool call makes Claude Code report the call "rejected" after the
command has run, and the agent runs it again.

Chris decided on 21 September 2026 to change nothing yet and to log first.
Each time Chris speaks over a running turn, `~/.sidetone/record.jsonl` gets a
`kind: "cutoff"` line with `waitedMs` and `interrupted`. The count on 24
September: 31 `interrupted: true` against 79 `false`.

Two bridge changes are open, and Chris chooses: queue Chris's speech without an
interrupt, or raise `interruptAfterMs`. A high count of `true` argues for a
longer wait. Done when Chris has chosen, and the choice is built or the item is
closed as "the workaround is enough".

## 5. Faster speech from the good voices

Noted 21 September 2026. Step one measured 21 September. Nothing built since.

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

Still to do: listen to Turbo, and decide whether its voice is good enough to
carry the stream. Look for cheaper ideas too, on the speech end: a shorter
first sentence, or a kept line that plays while the first sentence is made.
Measure each one with `kind: "answered"` in `~/.sidetone/record.jsonl`, not by
ear.

Done when the first sound of a chatterbox answer comes in under a second, or a
written reason says what it costs and Chris has said no.

## 21. A web dashboard for turns, timing and cost

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
  [`observability-brief.md`](observability-brief.md).
- The page uses a component framework and a CSS framework. Before the build,
  make several mock-ups with the `impeccable` skill and the skills that fit.
  Chris picks one.

Done when Chris can open a page and see one turn from start to end, and turn
timing and cost over time, not just the live recent window `/diagnostics`
gives today.

## 22. A desktop client

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

Noted 22 September 2026. Built and landed 23 September 2026 (15ed8e8, spec
4.2.2, 18.13) and 24 September 2026 (9a49cb9, the echo path in the test suite;
adfe8b0, the car check). Item 1, the volume of the phone audio path, closed
into this item on 24 September 2026. What is left is for Chris to weigh the
list of gaps at the end.

What was built. A unit test cannot hear the phone, so there are three parts:

| Part | What it catches | Runs |
|---|---|---|
| `android/.../Audio.kt` and `AudioTest` (spec 4.2.2, 18.13.1) | any change to the audio setup that has not passed the echo check, and any audio-path call outside `Audio.kt`: a track gain, a mode, focus, routing, a player of its own | `./gradlew testDebugUnitTest`, no phone |
| `bun scripts/echo-check.ts` (spec 18.13) | the canceller that does not hold: the bridge says a passage into the room and the record shows whether the microphone brought it back. It refuses a cut microphone and a dead capture (18.13.2, 18.13.3), because on 23 September both passed as a quiet room | on the bridge machine, with the phone in the room and nobody talking |
| `test/echo-path.ts` (9a49cb9) | the bridge's side of an echo, with no car: speech-shaped audio, delayed and attenuated through a modelled canceller into `Ear.frame`. A clean echo of one sentence is dropped and the held answer resumes; the whole passage comes back as one utterance of over 15 s at peak 0.54 and `verdict` calls it a fail; real speech over the voice is still heard | `bun test` |

The fourth assertion of `test/echo-path.ts` is a limit to know: at peak 0.54
with 300 ms bursts and dips over 200 ms, the barge-in gate never fires, because
each burst holds 300 of the 400 ms it needs and the dip resets the count. The
gate guards only a canceller that fails outright. A canceller that leaks onsets
leaves the words (18.10.1, 18.10.3) as the only guard.

The setup that ships passed the check in the car on 24 September, over
Bluetooth SCO to an Audi MMI at full volume, with the microphone open and the
capture live: nothing came back. `Audio.CHECKED_ON` says so. Run the check in
the car again before anything about the audio setup changes; `bun
scripts/audio-setup.ts` changes it without a build (18.15), and the record
names the setup each reading was taken with.

The phone's audio path, from item 1. What is still true:

- The app takes no volume of its own. A search of the `.ts` and `.kt` files
  finds only `cueVolume`, which scales the cues, and the gain in `src/audio.ts`.
  In the car the car's volume control works. On the phone alone the setting has
  little effect and a floor Chris cannot go under. The floor fits call mode:
  Android's voice-call stream often has a minimum of 1 and never reaches 0.
  Not verified on adb.
- Call mode stays. The car check settled it: call mode passes the echo check
  and media mode fails it (item 27). The level of the phone alone is a property
  of call mode, and a fix must keep call mode.
- An in-app volume slider (spec 4.2.1) shipped 21 September and was reverted
  22 September. Its gain on the bridge's track was loud enough to defeat the
  phone's echo canceller, so the bridge heard its own voice and barged in on
  itself. `AudioTest` now names a track gain outside `Audio.kt`, so a volume
  change is an audio-path change and needs the echo check before it ships.
- Playback volume sometimes jumps suddenly (item 25), especially with hold
  music. No case is on record. The hold music gain is set once, at decode time
  (spec 15.9), so a jump mid-track is in the transport or the phone, not the
  bridge. Get one case: the time, what was playing, the status on screen, and a
  screenshot, which now joins the next turn (item 38).

Other testing gaps, from the session transcripts of 20 to 23 September, for
Chris to weigh:

| What happened | Would a test have caught it? |
|---|---|
| `/play` fought the voice and the hold music (item 24) | Yes: a mouth test with a sentence that arrives while a track plays. `test/routes.test.ts` plays a track through `/play`; no mouth test of the clash exists. |
| The voice came out garbled from the pre-rendered replies (item 32) | Covered since 23 September: a kept line is kept only when the speech worker hears its text (11.6.1, item 33). |
| The voice said ".ts" about twelve times (item 34) | Covered since 24 September: a path is spelled for the voice, with a test (item 33 c). |
| All of the bridge's audio was lost after an app or bridge change (21 September) | A `scripts/fake-phone.ts` run after each bridge change hears what the bridge says, so it catches a loss on the bridge side. Nothing catches one in the app except the phone. |
| The app joined, played the voice, and sent no sound until a force stop (21 September) | Not before it happened; the bridge now detects a silent track and asks for a rejoin (18.9), and `JoiningTest` covers the app's side. |
| The opening sentence played after the hold music (item 31) | Covered, by the test that came with the fix. |
| Synthesis took 22 to 24 s a sentence while another job held the GPU (22 September) | No: it is load, not code. An alarm on the synthesis time would show it. None exists. |
| A barge-in stopped the background subagents (item 4) | No: it is Claude Code's behaviour, outside this repo. |

Done when Chris has weighed the two open rows, the `/play` clash and the
synthesis alarm, and each has a test or a written reason none is practical.

## 28. A proper options menu in the Android app

Noted 22 September 2026. Built and landed 23 September 2026 (010a92d, spec
17.22). Item 46 put a gear on it. Not yet used on the phone. What is left is
one use of the menu on the phone.

What was built. The gear at the end of the status row opens a menu with a
three-way verbosity selector (item 37), a tones switch, a hold music volume
slider and "Leave". `Options.kt` draws it. Each control sends the `setting`
message (9.4.9), so the bridge takes the path of the spoken command, and the
control shows only what the next `settings` message says. The bridge takes
`holdMusicGain` from a client (0 to 1, no answer) and decodes the next track at
it. `tones` joined `IN_FORCE`, so the app can read the switch back. The voice
choice and the audio switch stay out of the menu, because each already has a
command or a button.

Still to do:

- The choice of hold music track: dropped. Chris decided on 24 September 2026
  that the folder is the setting. Item 20 plays every file in
  `~/.sidetone/hold/` in turn, and he changes what plays by adding or deleting
  files. On 24 September the folder holds nine tracks.
- Not checked on the phone: the look of the menu, the slider inside a dropdown,
  and the volume heard in the car.
- Item 49 renames "Leave" to "Quit" in this menu and gives "Leave" a new job.

Done when the menu has been used on the phone once.

## 35. Permissions stop the agent, and the spoken confirm word may not exist

Noted 23 September 2026. Investigated 23 September 2026,
`~/.sidetone/findings/permissions-35.md`. Nothing built. The finding answers
both questions.

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

Done since: `CLAUDE.md` (eea4839) tells the agent to run long work as
`scripts/job <name> env -u CLAUDECODE claude -p ...`, with `scripts/job` as the
first word, so the allow rule matches.

Still to do:

1. A rule in `autoMode.allow` in `~/.claude/settings.json` for headless jobs
   started through `scripts/job`, in the form of the systemd rule already there.
   Checked 24 September: not there. Fix or move the `autoMode.environment`
   block: it still describes `imagegen`. Both are outside the repo.
2. Test: from a bridge-run agent, start three jobs, and check the transcripts
   for a classifier refusal.
3. Built 24 September 2026 (f388a42, spec 10.7-10.11). The bridge passes
   `--permission-prompt-tool stdio` and `permissions.ask` rules in `--settings`,
   because auto mode let 3 of 3 force pushes through with no request when the
   prompt tool was alone. `src/gated.ts` picks the four out; each waits for
   "continue", and every other asked command is allowed. Not yet used live.
4. The agreement word matches anywhere in an utterance (`plain.includes` in
   `src/commands.ts`), so "do not continue" agrees. The decision above says
   "continue" counts only as the answer to the question. Now that it gates a
   force push, this matters more.
5. The matcher does not see `bash -c`, `$(…)`, `xargs rm -rf` or
   `find -delete`. Auto mode still judges those.

Done when a job started by `scripts/job` does not stop on a permission, and
a gated action has been agreed and refused once by voice in the room.

## 36. Review every wake-word command

Noted 23 September 2026. The decisions landed 23 September 2026 (001ed63, spec
9.4.6, 9.4.11, 9.4.12), and the five verbosity commands with item 37 (c621b40).
Reviewed 23 September 2026, `~/.sidetone/findings/wake-36.md`: every one of
the 24 commands has a verdict. The fixes it asks for landed 24 September
2026 (59343d6): one word for one target, the toggles above `endTurn`, and the
bare "where" and "man" gone, each with the clash phrase as a test.

Counts from `~/.sidetone/record.jsonl`, 17 to 23 September 2026. Six commands
fired: end turn 24, carry on 5, stats 4, mute 3, unmute 3, interrupt on 2. The
wake word came 6 times with no command after it. The other 16 never fired.
Only mute and unmute have fired under "sidetone"; the rest of the evidence for
"sidetone" comes from the corpus, which uses two synthetic voices.

Landed: `summarize` gone, the bare `tones` and `interrupt` gone, "clear context"
needs both words, "continue" is the agreement word only, and every form is one
or two words.

Clashes the review found, with a probe and not from the record. The matcher
accepts a word within a spelling tolerance of the target, one character for a
word of five letters or fewer, and the first row that matches wins:

| Said | Reached | Should reach | Cause |
|---|---|---|---|
| turn the audio on, turn the music on, turn interrupt on | endTurn | the toggle | "on" is one letter from "in"; `["in","turn"]` comes first |
| what can I say | maleVoice | nothing | "can" is one letter from "man" |
| there, here | where | nothing | one letter from "where"; `where` discards a held answer, so this costs the most |
| mute the music | mute | musicOff | mute comes first and needs one word |
| in the wake-word hold: one more, make it so, the best, turn it on | tonesOn, maleVoice, carryOn, endTurn | speech | the hold matches three words or fewer with no wake word |

Still to do:

1. Add the clash phrases to `test/commands.test.ts` as failing cases.
2. Make the three changes: one word per target in `commandIn`, the on and off
   toggles above `endTurn` or `["in","the","turn"]` in its place, and drop the
   bare "where" and the form "man". Keep the corpus misses at 5 or fewer.
3. The spec: 9.4 lists 9 of the 24 commands, and the rest sit in 4.9, 11.9,
   11.10, 11.12, 15.4 and 15.7.3, with `stats` in none. A table in 9.4 that
   points to each section fixes it. 9.5 says two commands work while muted; the
   default muted set has four (`tonesOn`, `tonesOff` too). Still so on 24
   September.
4. The vault note "Wake Commands Lose Summarize And The Bare Toggles" still
   says "not landed".

Done when the clash phrases reach the right command in the tests, and 9.4 and
9.5 match the code.

## 38. A screenshot from the phone does not reach the agent, and the status shows twice

Noted 23 September 2026. Part 2 built and landed 23 September 2026 (ad48d25,
spec 14.12.5 to 14.12.7, 17.18.5), not tried on the phone. Part 1 answered 23
September 2026, `~/.sidetone/findings/double-status-38.md`. The guard it asks
for landed 24 September 2026 (aa328c2): `scripts/job` refuses a name whose job
directory has a live pid and no exit.

Part 1, answered. The double was the job lines, not the status row. The
screenshot shows four lines under the 11:29 answer: "Job wake-review
finished." and "Job status-dot finished.", each twice. The bridge and the app
did the correct thing four times: the agent started each job twice. A barge-in
during the `scripts/job` tool call made Claude Code report the call "rejected"
after the command had run. Chris said "Start them both", and the agent ran the
same command again. The four job directories have the same `command.txt` in
pairs, and each exited 0.

Also from the finding: the screenshot did reach the bridge. The app sent it,
and the bridge wrote it at 11:32:43 to `~/.sidetone/screenshots/`. The agent
looked in `~/.sidetone/share` and `~/.sidetone/screen` only. Part 2 answers
that: the turn text now names the file.

Part 2, what was built:

- The bridge keeps each written screenshot pending, and the next turn that
  Chris's words start takes all of them in order. A line for the agent names
  each file, and the transcript does not show that line. A screenshot alone
  starts no turn, and one that arrives after Chris speaks waits for the next
  turn, so it cannot race with the answer (11.11).
- A pending screenshot expires after 2 minutes.
- The bridge tells the app `screenshot` with a state: `pending`, `sent`,
  `expired` or `dropped`. The app shows the thumbnail with the mark "attached
  to your next message", and a tap sends a drop request.
- Tests: `test/screenshot.test.ts`, the fixture, `ConversationTest`,
  `ScreenshotTest` and `MessagesTest`.

Still to do:

1. `scripts/job` refuses a name that already runs in `~/.sidetone/jobs/` (a
   `pid` and no `exit`). One check in one script, with a test. It stops a
   double run from any cause.
2. On the phone: the thumbnail, the mark and the tap, and one turn where the
   agent opens a file the turn named.
3. A known limit: the bridge forgets the pending screenshots when it restarts,
   and nothing tells the app. The mark then stays, but no turn takes the
   screenshot.

Done when a second `scripts/job` with a running name is refused, and the agent
has opened one screenshot that Chris sent from the phone.

## 39. The app sends no crash report, and nobody has checked it for stability

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

Checked 24 September: none of the fixes is in the code.

Still to do, in this item:

1. On each launch, read `getHistoricalProcessExitReasons` and send those
   records too. It gives ANRs with a thread dump, native crashes, low-memory
   kills and permission kills, which the handler of part 1 misses. That record
   is the only vitals this app can have.
2. The one high finding: catch the throw in `switchMic`, set `micOn` only after
   `openMic` succeeds, add a `CoroutineExceptionHandler` to `Bridge.scope` that
   writes the crash file, and put a `try` around each message in `on`, so one
   bad message is dropped and the room goes on.
3. The forced crash on the phone that the done line asks for.

Follow-ups the finding names, each its own item if Chris wants them: StrictMode
in the debug build with `detectAll()` and `penaltyLog()`; keep the three cuts
across a process death in `SharedPreferences`; move `sendScreenLog` off the
main thread and count while the parts are built.

Done when a forced crash on the phone gives a file in `~/.sidetone/crashes/`
with the stack trace, the exit reasons are sent, and the Mic button cannot end
the process.

## 41. Voice input after the app was closed for a while

Noted 23 September 2026. Not investigated.

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

## 44. Change more settings without a rebuild or a restart

Noted 23 September 2026. The phone half built and landed 24 September 2026
(c051f12, spec 18.15). The bridge half is not started.

Chris tries a setting such as the hardware or software echo canceller by
building a new app, installing it and restarting the bridge. Each try cost
minutes, and it made the build in the room hard to know (item 42).

Phone half, what was built: a `setup` message carries the audio setup in
named values, mode, output, focus, canceller and the two flags, and `Audio.kt`
maps each name to its constant. The app keeps a pushed setup across a restart
and applies it by rejoining the room, because LiveKit builds the audio path at
join. `{"kind":"setup","default":true}` clears it. The `device` message and the
record name the setup in force and whether it was pushed. `bun
scripts/audio-setup.ts --canceller software` is the whole cost of an echo
experiment now. `AudioTest` still guards the setup written in the code, which
is what ships.

Bridge half, still to do. A client can set six keys today, through
`Conversation.set` in `src/conversation.ts`: `tones`, `holdMusic`,
`interruptOnSpeech`, `voice`, `verbosity` and `holdMusicGain`. The thresholds
are not among them: `minSpeechPeak`, `bargeInLevel`, the pause length, the echo
drop. Start with a list of every setting in the bridge config, and mark each
one as fixed, applied at the next turn, or applied at once. Reuse the `setting`
message and the config file; add no new channel.

Done when Chris changes one bridge threshold from a menu or a command, and the
next turn uses the new value with no restart.

## 49. Leaving the room keeps the app open, and one tap rejoins

Noted 24 September 2026. Built and landed 24 September 2026 (4d15b13). Not yet
used on the phone: Chris has to install the build and try it in the car. This
item takes over what was left of item 27.

Item 27 closed with a workaround: while the app is in a room the car sees a
call and parks its media, so Chris leaves the room to play music and rejoins to
talk. Today "Leave" quits the app, which is a heavy thing to do at the wheel.

"Leave" ends the room and the app stays open and in front, showing the
conversation it had, with a control large enough for a thumb to rejoin. The
pairing is kept, so there is no code to scan. Leaving releases the phone's
audio: the microphone track goes, the room connection ends, and the
communication device is cleared, so the car stops treating the phone as being
in a call. "Quit" moves into the gear menu (item 28).

The bridge needs no change: a phone out of the room is the case of a phone in a
tunnel (14.8), and the history arrives when it comes back.

Done when Chris taps Leave in the car, the music plays, the app is still on the
screen, and one tap brings the conversation back with the history.

## 50. The settings screen fills the window

Noted 24 September 2026, from using the app. Not started.

The options behind the gear are a dropdown menu (`Options.kt`, spec 17.22). It
is small, its controls sit in a narrow column, and a slider in a dropdown is a
poor target in a moving car.

The settings should fill the window, with the top bar and its gear the only
thing left around it. Tapping the gear opens it; the same tap or a back gesture
closes it. The controls are the ones the menu holds now, with room to grow as
item 44 adds the bridge's thresholds: verbosity, tones, hold music volume,
"Leave", "Quit" and the build line.

Done when the gear opens a screen that fills the window under the top bar, every
control in it works as it does in the menu today, and a back gesture returns to
the conversation.

## 51. A design pass on the status light and its legend

Noted 24 September 2026, from reading the legend on the phone. Not started.

Four of the seven states are amber: connecting, signal lost, reconnecting and
rejoining (`Reading.kt`). The colour therefore says almost nothing, and the
legend that item 45 added lists four rows that look the same. Green is
listening, red is disconnected, grey is left by hand.

Look at the light and the legend together, as one design rather than two:

- What the colour should carry, and how many colours that needs. A reader in a
  car has a glance, not a reading.
- Whether the four amber states are four states to a person, or one state
  ("not hearing you, working on it") with detail in the word beside the light.
- The word beside the light, which item 45 made always visible (17.11.7): it may
  be doing more of the work than the colour now.
- The ring, which carries the connection quality, and the motion, which carries
  work in progress: with a word and a colour, whether they are still worth the
  space.
- The legend's shape, now that it has a row for each state: what a person who
  taps the light actually wants to know.

Done when the light says at a glance which of the states that matter it is in,
the legend reads as one idea rather than a table of four ambers, and both are in
the spec.

## Done

One line for each item that shipped: the number, the title, the date, the
commit, and any finding that lived only in the item.

- **1. The volume of the phone audio path**, with item 25 merged in. Closed 24
  September 2026, answered by the echo work of 23 and 24 September (15ed8e8,
  adfe8b0). The level on the phone alone is a property of call mode, and the
  car check requires call mode. The in-app slider (spec 4.2.1) shipped 21
  September and was reverted 22 September: it defeated the phone's canceller.
  What is still true about the phone's audio path is in item 26. The volume
  jump has no case on record; item 26 says how to get one.
- **18. A tone at the true end of the agent's speaking.** Landed 24 September
  2026 (1a9228a, spec 15.15). A fourth cue: two clicks dark to bright, quieter
  and shorter than the others, the pair of `thinking`. The true end is the line
  after the second `mouth.drained()` in `runTurn`; the frames go behind the
  last sentence, so the phone plays it after the last sample. A barge-in that
  ends a turn gets no cue, a hold keeps it waiting, and `starting` keeps its
  three rising clicks. `tones off` silences it.
- **19. Highlight the chat text as it is actually spoken.** Landed 23 September
  2026 (cdab5b1, spec 17.21). Not yet seen on a phone. Two limits not in the
  spec: the grey follows only the newest spoken sentence, so the unheard end of
  a cut answer goes to full weight when the next answer speaks; and a sentence
  that repeats in one bubble matches its first place.
- **20. More hold music tracks, cycled, each resuming where it left off.**
  Landed 23 September 2026 (ca27825, spec 15.10.1). Every audio file in
  `~/.sidetone/hold/` is a track, in file-name order, wrapping; the position is
  in memory only, and a track resumes two seconds before where it stopped.
  The licence question is closed: Chris buys the tracks. The choice of a track
  is item 28.
- **27. Decouple audio focus from echo cancellation, so the app stops holding
  priority over other audio.** Closed 24 September 2026 (a991872; the work in
  15ed8e8, adfe8b0, cd636d6). The app cannot give it, and the reason is the
  car. Call mode over Bluetooth SCO passes the echo check, but the car hears an
  HFP call and parks its own media for the whole time the app is in the room.
  Media mode over A2DP lets music play, but the canceller fails: in the car the
  whole passage came back, 14.9 s at peak 0.54 (drive.md test 15). Releasing
  the focus changes nothing, and in LiveKit 2.28.2 the routing and the focus
  are one flag, so no focus meant the earpiece; the app now routes a no-focus
  setup itself (spec 4.2.2.1). Chris rejected a mode switch per turn: a second
  of SCO setup and a connect tone each time. Superseded by item 49. The
  research is `~/.sidetone/findings/echo-cancellation-23-september.md`: on
  A2DP no documented canceller has the reply as a reference, and a server-side
  canceller is an experiment, not a fix.
- **30. Compact the status row, and design it rather than grow it.** Landed 23
  September 2026 (1815e29, spec 17.11.6). One dot: colour for the room state,
  motion for the work, the ring for the quality; "Leave" into the menu. Item 45
  changed the word rule the same day: the word shows in every state. Not yet
  read in the car. The thought of a reconnect button in place of "Leave" went
  to item 49.
- **33. Garbled speech: first, let the agent hear the audio it sent**, with
  items 32 and 34 merged in. Parts a and b landed 23 September 2026 (ad0a0bc,
  spec 11.6.1, 18.14), part c 24 September 2026 (c582cf2). The format was never
  the cause: chatterbox garbles one-word text. The stored "Muted." of 18
  September said "I'm gonna kill Tevrazigan!", "Stopped." was 120 ms of
  silence, and fresh takes of "Muted." came out clean twice in twelve. A kept
  line is kept only when the speech worker hears its text, and the store was
  rechecked on 24 September. Chatterbox loops on ".ts": a sentence with a path
  garbled in 30 of 50 takes and looped in 14, and "src" comes out as "erks";
  a path spelled in upper case with spaces was clean in 30 of 30. The next
  report of garbled speech is settled from `bun scripts/sent-check.ts`.
- **37. A verbosity setting, as a command and in the app.** Bridge landed 23
  September 2026 (c621b40, spec 9.4.10), the app selector with item 28
  (010a92d). Three levels, one line at the head of each turn's prompt, saved
  in the settings file; the commands are `verbosity brief`, `verbosity
  normal`, `verbosity full`, `shorter` and `longer`.
- **40. The app learns of a new build only when it joins the room.** Landed 23
  September 2026 (3b35cbe, spec 17.15.5, 17.15.6). The bridge looks at the
  file every 2 seconds and sends `apk` when the hash changes and two looks
  agree. Not yet tried on the phone: a build while in the room, and the button
  within about 4 seconds.
- **42. The bridge cannot tell which build of the app is running.** Landed 23
  September 2026 (5ff60c1, spec 14.15). The leftover was bigger than the
  message: rtc-node adds the participants already in the room at `connect`
  without `ParticipantConnected`, so a restarted bridge sent a phone already
  there no `protocol`, `settings` or `history` at all. `device` also names the
  audio setup in force since c051f12.
- **43. Words in a chat bubble arrive scrambled on a bad connection.** Landed
  23 September 2026 (e33ec3c, spec 14.9.2.1). Not the connection: the LiveKit
  Android SDK posts each data message on `Dispatchers.Default`, so two sent a
  millisecond apart arrive in either order. Four chunks arrived reversed in a
  1 ms burst with every character present. Each delta carries `seq`.
- **45. The status light: smaller, a legend on tap, and the state word never
  shows.** Landed 23 September 2026 (98d96a8, spec 17.11.7). The word never
  showed because 17.11.7 withheld it for every state Chris expects, which is
  every state that lasts; it now shows in every state. The dot is 26 dp, from
  32, and a tap opens the legend. Only the phone can judge the size.
- **46. Replace the three-dot menu with a gear that opens settings.** Landed
  23 September 2026 (98d96a8). Same name for a screen reader, opens the menu
  of item 28.
- **47. Hold to talk keeps the turn open until the release.** Landed 23
  September 2026 (9b6861f, spec 9.5.2). `Utterances.held` stops the
  end-of-turn pause while the button is down; the test saw two turns before
  the change and one after.
- **48. The voice keeps speaking to the end of the sentence after a barge-in
  or audio off.** Landed 23 September 2026 (e72fec5). Both causes were
  measured: the LiveKit `AudioSource` holds about 1000 ms, so a cut left 787 ms
  playing, now under 500; and "Audio off." waited on the whole queue, so the
  held answer played on behind it. `frames()` clears the source on a cut, and
  `Mouth.quietAfter` turns the audio off when its own line ends.
