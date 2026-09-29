# Test audit, 29 September 2026

An audit of the bun tests in `test/`, the Kotlin tests in
`android/app/src/test/`, the scripts in `scripts/` and the manual checks in
`docs/testing.md`, at dcd6cca. The audit changed no code and no tests. The
section "The changes" at the end says what was done after Chris read it.

## What was run

| Command | Result |
|---|---|
| `bun test` (bun 1.3.3), run 1 | 978 pass, 12 skip, 0 fail, 33.14 s |
| `bun test` (bun 1.3.3), run 2 | 978 pass, 12 skip, 0 fail, 33.17 s |
| two `bun test` runs at the same time | both 978 pass, 0 fail, 33.7 s each |
| `bun test --rerun-each=5` on the five slowest files | 975 pass, 0 fail, 133.6 s |
| `bun test` on bun 1.4.2 (a scratch install), two runs | 978 pass, 0 fail, 33.1 s and 32.6 s |
| `bun test --concurrent` (bun 1.3.3) | 977 pass, **1 fail**, 14.8 s |
| `bun test --coverage` | 91.6 % of functions, 94.5 % of lines, over the files the tests import |
| `bun test --reporter=junit` | a time for each test (see "Where the time goes") |
| each file alone, `bun test ./<file>` | a time for each file (in the verdict table) |
| `bun run typecheck` | clean, 2.3 s |
| `./gradlew --offline :app:testDebugUnitTest` | 178 tests, 0 fail, 0 skip; 0.52 s in the tests, 29.6 s in Gradle |
| fake-timer probe, bun 1.3.3 and 1.4.2 | see "Tooling" |
| fake-timer pilot on two tests of `mouth.test.ts`, in a scratch copy | 2.75 s to 36 ms, both pass |

**Flakes.** None in eight full runs and five repeats of the slow files. The
one failure is under `--concurrent`: "a resume fades in too (item 52)" in
`turn.test.ts` sets the system clock with `setSystemTime`. The clock is
global to the process, so a test that runs beside it moves it. Without
`--concurrent`, bun runs the tests of a file one at a time, and the test
passes.

**Noise.** The suite prints journal lines to stdout (`[job news: ...]`,
`Nvidia Decoder is supported.`, `the voice garbled "Round 1."`) and one
`EEXIST` line from `record.test.ts`. The `EEXIST` line is on purpose: that
test checks that a record it cannot write does not stop the bridge.

**Side effect.** `MessagesTest.writesEverythingTheAppSends` writes
`test/fixtures/from-app.jsonl` on each Gradle run. The content did not change,
so the tree stayed clean. This is the contract of ADR 0007, and a change to
the app's encoders shows as a diff.

### Where the time goes

| Share | Tests | Time |
|---|---|---|
| tests of 0.1 s or more | 64 of 990 | 30.3 s of 32.8 s |
| all other tests | 926 | 2.5 s |

Every slow test waits on the real clock: `Bun.sleep`, `setTimeout`, or an
`until()` loop that polls every 2 ms. The slowest tests:

| Time | File | Test |
|---|---|---|
| 2.18 s | drive | two tracks asked for during a turn with the hold music on both play whole |
| 2.00 s | bridge | job news waits while Chris talks |
| 1.65 s | mouth | it never goes over a sentence or into a hold |
| 1.15 s | routes | it waits while the bridge speaks, then plays |
| 1.10 s | bridge | 14.16.4 a new bridge says it started once (and its neighbour) |
| 1.10 s | mouth | it waits for the turn to end |
| 1.02 s | fixture | the bridge still sends what the fixture holds |
| 1.01 s | turn | a track the source refuses waits for the source |
| 1.00 s | session | 8.6 the silence timer runs on across the result |

`turn.test.ts` alone takes 13 s: 35 hold-music tests wait multiples of
`AFTER = 100` ms.

## 1. Tooling

| Part | Now | Current? |
|---|---|---|
| bun runner | 1.3.3 (November 2025) | No. npm has 1.4.2. |
| mocks | none: hand-written fakes in `harness.ts` and in each file | Right as it is. The fakes carry behaviour; `mock()` would record calls only. |
| fake timers | none | Not possible on 1.3.3: `jest.useFakeTimers` exists, but `jest.advanceTimersByTime` does not. Works on 1.4.2. |
| clock | `setSystemTime` in 2 files | Current. It is global to the process (see the `--concurrent` failure). |
| snapshots | none; contract fixtures in `test/fixtures/` | Right. `messages.jsonl` and `from-app.jsonl` are read by bun, Kotlin and the page, so they must stay plain JSONL, not bun snapshots. |
| coverage | not configured; no `bunfig.toml`, no CI | `bun test --coverage` works. |
| JUnit | 4.13.2 | The last 4.x. JUnit 4 is in maintenance, but it works. |
| kotlinx-coroutines-test | not used; `runBlocking` and `withTimeout(5_000) { while (!done()) yield() }` | Not needed yet: no Kotlin test waits on `delay`. |
| Turbine | not used; tests read `StateFlow.value` | Not needed: no test asserts a sequence of flow values. |
| Robolectric | not used | Not needed for the tested classes; see Gap A7. |
| `JoiningTest` clock | a `now` field passed to `Joining.on` | Better than virtual time: the state machine is pure. |
| `test/harness.ts` | builds the real `assemble` with fake engines, agent and speaker | No maintained tool does this. It is the one copy of the wiring, and it is correct as the design. |
| `test/echo-path.ts` | makes speech-shaped audio, an echo path and a canceller as numbers | No maintained tool does this. Recorded wav files would lose the control of delay, gain and leak that the tests need. |
| `scripts/browser-check.ts` | the `playwright` library, not `@playwright/test` | Adequate. It prints and exits 0 in every case (see Value). |

### Upgrades, with cost and gain

| # | Upgrade | Cost | Gain |
|---|---|---|---|
| T1 | bun 1.3.3 to 1.4.2 | Small. The suite passes unchanged on 1.4.2, two runs. The live unit runs `bun` too, so the bridge moves with it. | Working fake timers (probed: `advanceTimersByTime`, `Date.now` under fake timers, `setInterval`, `Bun.sleep` all move). `advanceTimersByTimeAsync` is still absent. |
| T2 | fake timers in the 64 slow tests | Medium. Each test gets `jest.useFakeTimers()` and a helper that advances time in steps and lets promises settle between steps. The harness's `track()` polls `Date.now` with `setInterval(2)`, which fake timers cover. Needs T1. | The suite goes from 33 s toward 3 to 5 s (estimate; the pilot cut 2 tests from 2.75 s to 36 ms). Less exposure to a loaded machine. |
| T3 | `bun test --concurrent` | Small to switch on; the `setSystemTime` test fails, and every test that shares the process clock is at risk. | 33 s to 15 s. T2 gives more with less risk. Not recommended. |
| T4 | coverage in a `bunfig.toml`, with a threshold | Small. | Low. The imported files are at 94.5 % of lines. The gaps are in `src/main.ts`, which no test imports, so a threshold does not count it, and in `src/serve.ts` (8 %), `src/keys.ts` (51 %), `src/transport.ts` (68 %) and `src/speech.ts` (84 %) (see Gaps). Run it by hand when looking for gaps. |
| T5 | kotlinx-coroutines-test | Small: one `testImplementation`. | Only when a Kotlin test must pass a `delay` or a backoff, for example the reconnect timing in `ClientRoom`. Not now. |
| T6 | JUnit 5 on Android | Medium: the third-party `android-junit5` Gradle plugin. | Parameterized tests. No current test needs them. Not recommended. |
| T7 | Robolectric | Large: a slow first run and an SDK jar per API level. | Tests for `Bridge.kt`, `BridgeService.kt` and `Update.kt`, which have none. See Question 3. |
| T8 | Turbine | Small. | None now. Not recommended. |

## 2. Gaps

The column "Closes it" says whether a machine test can close the gap, or
whether it needs the phone at the desk or the car, as `docs/testing.md` says.

| # | Voice path | What is tested | What is not | Closes it |
|---|---|---|---|---|
| A1 | Audio capture, bridge side | `Utterances` and `Ear` with synthetic frames (`audio`, `ear`, `echo-sim`); one track per participant in `transport.test.ts` with a fake room | The real `@livekit/rtc-node` `AudioStream`: frame size, rate, and the 48 kHz resample on a real track | Machine: LiveKit in Docker and a second rtc-node participant. `scripts/fake-phone.ts` already does this, but asserts nothing. |
| A2 | Audio playback, bridge side | `roomSpeaker` with a fake source; the cut leaves under half a second (`transport`) | The real `AudioSource` queue under load; the level the phone receives (item 70: tests pass, Chris hears the fade the wrong way round) | Desk: `scripts/hold-level.ts` measures sent and received. Car for what Chris hears. |
| A3 | Audio capture and playback, phone side | `AudioTest` pins the setup constants and a rule that only `Audio.kt` touches the audio path | `AudioRecord`, the phone's echo canceller, the route to the car, focus and mode | Desk: `scripts/echo-check.ts` with the phone in the room. Car: drive tests 6 and 7. |
| A4 | Echo and hold | Strong. `echo`, `echo-sim` (the 23 September case), `conversation` (the hold table), `mouth`, `answers` | The real canceller's leak shape; `echo-path.ts` models it from one drive | Desk: `echo-check.ts`. Car for the road. |
| A5 | Turn taking and barge-in | Strong at the bridge: the pause, the tentative end, the barge-in edge, hold to talk, the shadow turn detector with a fake worker (`turn-guess`) | Real speech levels and real pauses; whether the detector's threshold works | Car: drive test 16 (about 100 ends on a pause; 89 so far). |
| A6 | STT and TTS streaming | `SpokenAhead`, kept lines, carriers and the sentence collector with fake engines; `speech.smoke` with the real models | The `Worker` class in `src/speech.ts` (start, the ready line, an error reply, a line that is not JSON, a worker that dies mid-request) and `speech/worker.py`. `speech.smoke` covers them only with `SIDETONE_GPU=1`, by hand. | Machine, no GPU: a stub worker (a few lines of Python or bun) that speaks the protocol. Whisper's accuracy on Chris's voice: car, drive test 17. |
| A7 | Latency | The arithmetic: `latency`, `measures`, `scorecard`, the marks in `mouth` and `turn` | No test holds a budget. Real times come from the record and `session-check.ts score`. `fake-phone.ts` prints first-audio times with no limit. | Machine with the GPU: a desk run of `fake-phone.ts` with a limit on the first-audio time. The car for the network. |
| A8 | Cues | `cues` measures length and level of each built wav; `conversation` and `answers` check order and that no cue plays over the voice | Whether a cue is audible in the car over road noise | Car only. |
| A9 | LiveKit room, bridge side | Token grants, the unique identity, the clients the bridge is told of, the channel before the engines are warm (drive test 13) | `Transport.joinWhenReady` (the retry at boot), `connect`, `publish`; `src/serve.ts` is at 8 % of lines | Machine: `joinWhenReady` against a closed port and a fake `join`, no LiveKit needed. The order in `serve.ts`: desk, `scripts/warm-join.ts` (needs LiveKit and the engines). |
| A10 | Reconnect, phone side | `JoiningTest` plays both restarts on its own clock; `ClientRoomTest` with a fake `Room` | `LiveKitRoom.kt` (the adapter to the SDK), `BridgeService.kt`, `Bridge.kt` (309 lines, the process-level state), `Update.kt` | Machine for `Bridge.kt` and `Update.kt` with Robolectric or a seam (Question 3). The watched restart: car, drive test 8. |
| A11 | The page | `client/decode.js` against the fixture; the refusal rule by text search | Everything the page does in a browser | Desk: `scripts/browser-check.ts`, which prints and does not fail. |

## 3. Value

### Bun tests

Time is the file run alone, bun 1.3.3.

| File | Tests | Time | Verdict | Reason |
|---|---|---|---|---|
| answers | 5 | 0.02 s | keep | Which answer owns the mouth; pure rules that broke before. |
| apk | 2 | 0.22 s | keep | Real file and watcher; two 60 ms waits. |
| audio | 25 | 0.40 s | keep | The end of an utterance and the barge-in count; the core of turn taking. |
| bridge | 34 | 5.84 s | keep | The assembled bridge. One test, "the audio off reaches the mouth", is inside drive test 12 and "the audio button is kept": drop it. Move the sleeps to fake timers (T2). |
| carrier | 13 | 0.04 s | keep | Cuts real wav data; checks the carrier table against the kept lines. |
| channel | 26 | 0.03 s | keep | Every message kind and its end. |
| commands | 52 | 0.05 s | keep | The matcher; each clash in it came from a car. |
| config | 23 | 0.03 s | keep | Refusals of bad files. One test pins 14 default values by hand; see Question 1. |
| conversation | 117 | 0.46 s | keep | The largest behaviour file, and fast. |
| crash | 4 | 0.03 s | keep | Real files; the failure paths. |
| cues | 6 | 0.09 s | keep | Measures the built audio, not a constant. |
| device | 9 | 0.02 s | keep | The build comparison and the setup names. |
| diagnostics | 5 | 0.02 s | keep | The ring buffer and its counts. |
| drive | 8 | 2.39 s | keep | The desk half of the drive card. Rewrite one test: drive 14's second test calls `ears.stopSpeaking()` and `mouth.say()` directly, where the harness asks for `talk()` and `hush()`. |
| ear | 34 | 0.08 s | keep | The pause, the release, the dead microphone. |
| echo | 20 | 0.03 s | keep | The text likeness and the echo check; real cases from 23 September. |
| echo-sim | 7 | 0.30 s | keep | Levels, not words; does not repeat `echo.test.ts`. |
| fixture | 2 | 1.07 s | keep | The contract file for bun, Kotlin and the page (ADR 0007). |
| gated | 89 | 0.02 s | keep | The safety gate; a table of real commands. |
| health | 5 | 0.23 s | keep | A restart loop of 23 September. Merge "the allowance is longer than the load" into "an engine still loading": same function, same branch. |
| heard | 39 | 0.05 s | keep | The engine's real spellings; not the phrase list written twice. |
| incoming | 4 | 0.04 s | keep | The app's own encoded messages reach each end. |
| keys | 6 | 0.06 s | keep | File mode 600 and a stable pair. |
| latency | 17 | 0.04 s | keep | The round trip and its split. |
| measures | 9 | 0.02 s | keep | One fact, told once, to the record and the report. |
| messages | 6 | 0.03 s | keep | The refusal rule, checked against the page and the app source. |
| mouth | 35 | 3.22 s | keep | The hold, the resume, the clips. The announcement tests wait 5 × 550 ms: the T2 pilot. |
| narrator | 5 | 0.03 s | keep | The delay before a tool is said. |
| network | 8 | 0.02 s | keep | The quality reading. |
| outbound | 5 | 0.10 s | keep | The size limit and the order. |
| pairing | 1 | 0.22 s | rewrite | It pins a literal link; `PairingTest.kt` pins the same literal by hand. Write the link to a fixture that both read, as `messages.jsonl` does, so a drift fails. |
| protocol | 21 | 0.02 s | keep | The stream facts, from recorded runs. |
| record | 9 | 0.04 s | keep | Survives a restart and a half line. |
| routes | 22 | 2.71 s | keep | Pairing backoff, the local-only routes, `/play`. Sleeps: T2. |
| scorecard | 24 | 0.03 s | keep | The drive score. |
| screen | 4 | 0.04 s | keep | Real files. |
| screenshot | 17 | 0.16 s | keep | Parts, expiry, and the turn that takes it. |
| sent | 18 | 0.08 s | keep | The kept clips and the garble check. |
| sentences | 16 | 0.05 s | keep | Where a sentence ends; items 31 and 69. |
| session | 31 | 1.09 s | keep | Replays real Claude Code runs; item 4 races. |
| settings | 3 | 0.03 s | keep | The one writer of the settings. |
| setup | 3 | 0.02 s | keep | Names to setup, refusals. |
| speech.smoke | 12 (skip) | 0.04 s | keep | The only test of the real engines; by hand with `SIDETONE_GPU=1`. |
| spoken | 25 | 0.18 s | keep | Kept lines, tries, carriers. |
| supervisor | 15 | 0.04 s | keep | The escalation ladder on a clock. |
| transport | 30 | 1.12 s | keep | Resample, frames, tokens, the speaker, the tracks. |
| turn | 96 | 12.95 s | keep | Hold music and mid-answer questions. 40 % of the suite's time: T2 first here. |
| turn-guess | 11 | 1.85 s | keep | The shadow detector never holds up the ear. |
| working | 12 | 0.03 s | keep | The sign, the jobs, and the heartbeat against `Work.kt`. |

No file is mock-only or tautological. Every harness test runs the real
`assemble`; only the engines, the agent and the speaker are fakes.

### Helpers

| File | Verdict | Reason |
|---|---|---|
| test/harness.ts | keep | The one copy of the wiring. No tool replaces it. |
| test/echo-path.ts | keep | The echo as numbers. No tool replaces it. |

### Kotlin tests

All 178 pass in 0.52 s. The verdicts come from the names and a partial read.

| File | Tests | Verdict | Reason |
|---|---|---|---|
| AudioTest | 12 | keep | Pins the checked setup, on purpose (18.13). Rewrite one test: "a setup with no focus asks for no mode" asserts nothing when `focus` is set. |
| ClientRoomTest | 9 | keep | The room client with a fake `Room`. |
| ConversationTest | 28 | keep | Named in drive test 4. |
| CrashTest | 15 | keep | Reports, exit records, the coroutine handler. |
| CutsTest | 3 | keep | The kept cut survives a process death (17.10.5). |
| JoiningTest | 17 | keep | The reconnect state machine on its own clock. |
| MarkdownTest | 13 | keep | Rendering rules. |
| MessagesTest | 27 | keep | Decodes the fixture and writes `from-app.jsonl`. Merge `aToolCallSplitsAnAnswerIntoTwoBubbles` with ConversationTest's test of that name: same messages, same assertions. |
| PairingTest | 3 | keep | Read the shared fixture of the `pairing` rewrite. |
| ReadingTest | 11 | keep | The status words and colours. |
| ReceivedTest | 2 | keep | WebRTC's number types (item 56). |
| ScreenLogTest | 11 | keep | Size limits in bytes. |
| ScreenshotTest | 7 | keep | Parts and scaling. |
| SpokenTest | 4 | keep | The grey after the spoken sentence. |
| TranscriptTest | 9 | keep | The log of the screen. |
| WorkTest | 7 | keep | Delete `theStaleTimeIsThreeHeartbeatsOfTheBridge`: it pins `5_000` by hand, and `working.test.ts` already checks `Work.kt` against `HEARTBEAT_MS`. |

### Scripts

The third column says whether the exit code gives the result, not only a
usage or setup error.

| Script | Kind | Exit code gives the result | Verdict |
|---|---|---|---|
| audio-setup | tool: push a setup | n/a | keep |
| browser-check | check | **no**: `NO ANSWER within 90s`, an overflow and page errors all exit 0 | rewrite: exit 1 on any of them |
| echo-check | check | yes | keep |
| fake-phone | driver | no: exit 1 only when it cannot pair; it asserts nothing on the conversation | keep as a driver; see A1 and A7 |
| first-word | bench, item 55 (open) | n/a | keep |
| heard-refresh | writes `heard.json` | n/a | keep |
| hold-level | measurement, item 70 (open) | n/a: exit 1 only when no track plays | keep |
| protocol-check | check after a Claude Code upgrade | yes | keep |
| renew-cert | operations, not a test | yes | keep |
| screenshot-link | experiment, item 59 (done; the change was not kept) | n/a | see Question 2 |
| sent-check | diagnostic | yes: exit 1 on a garbled clip | keep |
| session-check | drive score | n/a | keep |
| warm-join | check, drive test 13 | yes | keep |

### Manual checks in docs/testing.md

Each open drive test names its desk half, and each desk half exists and
passes: test 1 and 11 in `conversation.test.ts`, 4 in `turn.test.ts` and
`ConversationTest`, 7, 10, 12, 13, 14 and 15 in `drive.test.ts`, 13 also in
`warm-join.ts`, and 8 in `JoiningTest`. What stays for the car is what a
machine cannot hear: whisper over the road, Android Auto, and what Chris
hears.

## Recommended changes, ranked

| Rank | Change | Why first | Size |
|---|---|---|---|
| 1 | Upgrade bun to 1.4.2 (T1) | Unblocks 2; the suite already passes on it. | minutes |
| 2 | Fake timers in `turn`, `bridge`, `mouth`, `routes`, `drive` (T2) | 30 of 33 s; takes the wall clock out of 64 tests. | an hour or two |
| 3 | A stub-worker test for `Worker` and `speech/worker.py` (A6) | The protocol every engine uses has no test without the GPU. | under an hour |
| 4 | A test of `Transport.joinWhenReady` (A9) | The boot race of 14.1 has no test. | minutes |
| 5 | `browser-check` exits 1 on failure | A check that cannot fail is a printout. | minutes |
| 6 | Share the pairing link as a fixture (`pairing.test.ts`, `PairingTest.kt`) | The same pattern as ADR 0007, for the one contract left out. | minutes |
| 7 | Remove the duplicates: bridge "the audio off reaches the mouth", MessagesTest's tool-call test, WorkTest's stale-time test; merge the two health tests | Less to keep in step. | minutes |
| 8 | Rewrite drive 14's second test with `talk()` and `hush()`; fix AudioTest's conditional test | The tests then check the path the car takes. | minutes |
| 9 | A first-audio limit on a desk run of `fake-phone.ts` (A7) | Latency has figures, and no test holds a budget. Needs the GPU. | an hour |
| 10 | Robolectric or a seam for `Bridge.kt` and `Update.kt` (A10, T7) | The largest untested Kotlin; waits on Question 3. | hours |

## Questions for Chris

Answered on 29 September: keep `config.test.ts`; delete
`scripts/screenshot-link.ts`; add Robolectric and test the four Android
files with it.

1. `config.test.ts` "the defaults are the values the spec settles on" pins
   14 values of `DEFAULTS` by hand. It fails on every change to a default,
   which is either the point (the spec and the code agree) or a second place
   to edit. Keep it as the spec's check, or delete it?
2. `scripts/screenshot-link.ts` measures a design that item 59 rejected on
   28 September. The result is in the to-do item. Keep the script as the
   evidence, or delete it?
3. `Bridge.kt` (309 lines), `Update.kt`, `BridgeService.kt` and
   `LiveKitRoom.kt` have no tests. Robolectric reaches them as they are; a
   seam like `Room` reaches `Bridge.kt` and `Update.kt` with no new tool but
   changes the code. Which, or neither?

## The changes

Done on the job branch after Chris answered the questions, one commit for
each change.

### Each recommendation

| Rank | Change | State | What was done |
|---|---|---|---|
| 1 | bun 1.4.2 | done | `~/.bun/bin/bun` is 1.4.2 (`bun upgrade`); 1.3.3 is kept at `~/.bun/bin/bun-1.3.3`. `package.json` has `engines.bun >=1.4.2`, and the README says why. |
| 2 | fake timers | done | `test/clock.ts`: `fakeClock()`, `pass(ms)`, `until(done)` and `finish(promise)`. On the fake clock: `turn` (hold music, the voice reaching a sentence, a track asked for), `mouth` (announcements), `bridge`, `routes` (`/say`, `/tell`, `/play`), `drive`, `turn-guess`, `fixture` (the scenes), and the watchdog test of `session`. |
| 3 | the worker protocol without the GPU | done | `test/worker.test.ts`: a stub worker that imports the real `speech/worker.py`. Nine tests: the ready line, a refused start, order, an error reply, a library that prints to stdout, a line that is not JSON, a worker that dies, a stopped worker, the turn detector's fields. Removing the stdout swap in `worker.py` fails one of them. |
| 4 | the join at boot | done | Three tests in `transport.test.ts` on the fake clock: the doubling wait under one identity, the cap at 5 s, the deadline. |
| 5 | `browser-check` can fail | done | It exits 1 on no answer in 90 s, on horizontal overflow and on page errors, and prints `PASS` or `FAIL: <reasons>`. `docs/testing.md` says so. |
| 6 | the pairing link as a fixture | done | `test/fixtures/pairing.json`. `pairing.test.ts` checks the bridge against it; `PairingTest.kt` parses it. |
| 7 | duplicates | done | Removed: bridge "the audio off reaches the mouth", `MessagesTest.aToolCallSplitsAnAnswerIntoTwoBubbles`, `WorkTest.theStaleTimeIsThreeHeartbeatsOfTheBridge`. The health allowance test is merged into "an engine still loading is not a fault". |
| 8 | rewrites | done | Drive 14's second test barges in with `talk()` and `hush()`. AudioTest's focus rule is one assertion on `Audio.setup` and `Audio.checked` that runs every time. |
| 9 | a first-audio limit on `fake-phone.ts` | not done | Two reasons. `fake-phone` starts a bridge of its own, with its own engines, and the live bridge already holds 6.3 of the card's 12.2 GB. And 16.5 says the target comes from the real setup, and no target is set. It needs a number from Chris and a desk run with the live bridge stopped. |
| 10 | Robolectric for the Android files | done | Robolectric 4.17 on SDK 36. `UpdateTest` (4), `BridgeTest` (6), `BridgeServiceTest` (5). `LiveKitRoomTest` (11) runs on `livekit-android-test` 2.28.2, LiveKit's own Robolectric harness, because a LiveKit `Room` needs WebRTC's native library, which does not load in a JVM. |

### Times and counts

| Suite | Before | After |
|---|---|---|
| `bun test` | 990 tests, 33.1 s | 1000 tests (988 pass, 12 skip), 5.3 s |
| `turn.test.ts` alone | 12.95 s | 2.3 s |
| Gradle `testDebugUnitTest` | 178 tests, 0.52 s in the tests | 202 tests, 6.1 s in the tests |

The bun tests still over 0.1 s do real work: ffmpeg decodes in `turn`
(item 20) and `audio`, the first load of `@livekit/rtc-node` in
`transport`, and file reads in `apk`. `conversation.test.ts` "Chris
starting a line just after the voice ends" waits 100 ms of real time,
because the fake clock stops when the test gives it back and the next
call reads `Date.now()`.

### What was run

| Command | Result |
|---|---|
| `bun test`, twice, after the last edit | 988 pass, 12 skip, 0 fail; 5.36 s and 5.32 s |
| two `bun test` at the same time | both 0 fail, 5.53 s each |
| `bun test --rerun-each=5` on the ten changed files | 1400 pass, 0 fail, 17.8 s |
| `bunx tsc --noEmit` | clean |
| `./gradlew :app:cleanTestDebugUnitTest :app:testDebugUnitTest`, twice | 202 tests, 0 fail, 6.2 s and 6.1 s in the tests |
| `browser-check` against a stub page that never answers | `NO ANSWER within 90s`, `FAIL: no answer`, exit 1 |
| `browser-check` against a stub page that answers | `PASS`, exit 0 |
| mutations, one at a time and reverted | no stdout swap in `worker.py`: 1 bun fail. No `session.abandon()` in `Update.kt`: 2 fail. A phone leaving said as a bridge leaving in `LiveKitRoom.kt`: 1 fail. `join` that forgets a room left by hand in `Bridge.kt`: 1 fail. |

### What was learned

- bun's fake timers also stop the test timeout. A test that waits on the
  fake clock for something that never comes hangs, and does not fail
  after 5 s.
- bun's `expect(promise).rejects` runs the event loop until the promise
  settles. On the fake clock nothing moves, so it never returns. The
  converted tests catch the failure with `.then(ok, fail)`.
- `setImmediate` stays real under bun's fake timers. `settle()` uses it to
  let promises run between steps.
- Real I/O does not wait for the fake clock: ffmpeg's first decode of a
  hold track runs before the turn in `slow()` and in drive test 15.
- Two tests freeze the clock with `setSystemTime` and stay on the real
  clock: "a track resumes two seconds before where it stopped" and "a
  resume fades in too (item 52)". The fake clock moves while a poll sees
  the cut, and the resume point would be 2 ms off.
- Robolectric 4.17 needs `--add-exports=java.base/jdk.internal.access=ALL-UNNAMED`
  on Java 21 here, and keeps `object Bridge` between tests while it gives
  each test a new application. `newBridgeProcess()` in `BridgeTest.kt`
  resets the object by reflection. No product code changed for a test.

### Left open

- Rank 9, above.
- `LiveKitRoom`: `Reconnected` and `received()` have no test. The mock
  server takes no reconnect, so a dropped link gives `Reconnecting` and
  then `Ended("the connection dropped")`, and that is what the test holds.
- `Bridge`: `sendScreenshot`, `installUpdate` and `sendDevice` have no
  test.
- Item 59 in `docs/todo.md` still names `scripts/screenshot-link.ts`. The
  script is in the history at 5934c67. The job did not write `docs/todo.md`,
  which `aleph todo` owns in the main checkout.
- The live bridge restarted at 10:59 on 29 September, after the upgrade,
  and runs on bun 1.4.2 (`/proc/<pid>/exe --version`). It is active.
