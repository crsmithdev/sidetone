# Testing

Two kinds of test check Sidetone. The test suite runs on this machine with no
phone. The drive card is a list of tests that Chris does in the car, for the
parts that only a real drive can show.

## The test suite

```bash
bun test              # the whole suite; it needs no GPU and no audio
bun run typecheck
```

The supervisor takes a clock, so the tests run the whole escalation with no
process. A clock cannot show that the interrupt shape is right, that a
restarted process answers, or that the ladder ends a real turn. These were
checked by hand against claude 2.1.267.

One file needs the card:

```bash
SIDETONE_GPU=1 bun test speech.smoke
```

It starts kokoro and whisper against the real models. It asserts that
onnxruntime took the graph on the GPU, because without its CUDA libraries it
gives no error. It uses the CPU, and a sentence costs a second instead of
120 to 165 ms. Then kokoro says a sentence and whisper reads it back. When the
chatterbox environment and the default reference wav are present, it also
checks chatterbox on the GPU.

The test skips without `SIDETONE_GPU=1`. It also skips when the kokoro model or
its environment is absent, and the chatterbox part skips when its reference
wav or environment is absent. A skip prints the path it did not find.

`bun test` cannot reach the page, so two scripts do what a unit test cannot.
Run both against a bridge of your own, never the live bridge on 3100. The
fake phone starts its own bridge. For `browser-check`, start one on another
port with a config of its own:

```bash
echo '{ "servePort": 3102, "room": "check" }' > /tmp/check.json
SIDETONE_CONFIG=/tmp/check.json bun src/main.ts serve /tmp   # prints the pairing code
sox question.wav mic.wav pad 1 25                              # silence, so the question does not repeat
bun scripts/browser-check.ts http://127.0.0.1:3102 <code> mic.wav
```

`browser-check` drives the real page in Chromium, with the wav as the
microphone. It refuses a URL with `3100` in it unless you set `LIVE=1`.
`PHONE=1` runs it at phone width. `INSECURE=1` accepts a self-signed
certificate.

`scripts/fake-phone.ts` is a phone with no phone. It pairs, joins, and speaks
with the same local engine the bridge uses, in the other voice. It
transcribes what the bridge says back, so you can script and read a spoken
conversation. It ignores the cues when it decides that the bridge has
finished. A cue is about 90 ms of sound, and a check that took one as speech
ended before the agent answered.

```bash
bun scripts/fake-phone.ts "what is two plus two" "say the word done"
bun scripts/fake-phone.ts --dir ~/some-project "summarise the readme"
bun scripts/fake-phone.ts --barge 6000 "list twenty primes" "stop, different question"
bun scripts/fake-phone.ts "run something slow" "+30s:continue"
```

A line may say when it is spoken. Some things happen only on a clock, for
example the checkpoint of 8.6.3. A script that waits for the bridge to finish
arrives before them, and the bridge takes it as ordinary speech.

After each Claude Code upgrade, measure the stream facts again (spec 16.2):

```bash
bun scripts/protocol-check.ts --runs 3            # Haiku; --model sonnet for the bridge's model
```

It drives the real `claude` with the bridge's flags, text in. It prints one
line for each fact: the runs that held, the runs in all, and the claude
version. It costs money and needs the network, so it is not in `bun test`.

`test/drive.test.ts` runs the drive card's bridge checks in `bun test`, one
describe for each test. Drive test 13 also needs the real process, because
only `serve.ts` shows the order of the join and the handlers:

```bash
bun scripts/warm-join.ts          # needs LiveKit on 7880 and the speech engines
```

It pairs with a bridge of its own, restarts it, and joins at once with the
kept token, as the app does. It prints one line for each pass condition of
test 13. In a worktree, link `.venv` to the main checkout's first.

## Score a drive

A drive is a script that you read aloud in the car, and a score of the result:

```bash
bun scripts/session-check.ts card     # what to say, in order
bun scripts/session-check.ts score    # how it went
```

Read the card with the phone connected, then score it. The score is the same
set of figures each time, so you compare two builds by figures, not by
memory. The figures are the commands that fired, the part of the passage that
came back word for word, the median round trip, and the settings.

The bridge appends the record to `~/.sidetone/record.jsonl` (`recordPath`).
Each event is one line of JSON, and a header line opens each session. `score`
reads the last session that heard anything. Thus it ignores the empty session
that a restart leaves.

## The drive card

The open questions about this bridge, and the test that settles each one. Every
test is something Chris does in the car and the bridge checks from the journal,
so the answer is evidence rather than an impression.

Read a test out loud before it starts, one at a time. Gather the evidence
yourself: `journalctl --user -u sidetone.service --since "-10 min"` is the
whole record of the drive, `~/.sidetone/record.jsonl` holds every utterance
and its measurements, and `adb` (at `~/Android/Sdk/platform-tools/adb`, not on
the PATH) reaches the phone once it is paired over wireless debugging. Never
ask Chris for something a command answers.

Write each verdict into the vault page "Voice Bridge Car Test 4" as it lands.
The drive ends when every test below has a verdict, or a reason it was skipped.

The tests below are in the order to run them.

### What is open

The drive of 27 September passed tests 2, 3, 5 and 8, and most of 1 and 4.
Test 15 failed. The vault page has each verdict. These are open:

| Test | What is left |
|---|---|
| 1 | "sidetone, end the turn" during a replay |
| 4 | an answer with a tool call: two bubbles |
| 7 | the Mic button and Android Auto's voice input |
| 10 to 14 | the hearing only; 9 is answered without a drive, and 14 passes at the desk |
| 6 | only if Android Auto's audio stays blocked after the app leaves the room |
| 15 | a rerun after to-do item 61 lands |
| 16 | a drive with the microphone open, for the turn detector and the names |
| 17 | all; needs `keepHeardClips` on for a whole drive, not this one |

Run them in this order: 1, 4, 7, then 10, 11, 12 and 14, then the restart of
test 8 with test 13 last. Test 16 changes how test 1 behaves, so ask Chris at
the start: run test 16 on the way back, or on another drive.

### Before the car

The live unit runs the code it was started with. Restart it when the running
commit is not HEAD, that is, when the last commit on `main` is newer than the
start time:

```
systemctl --user show sidetone.service -p ExecMainStartTimestamp
git -C ~/sidetone log -1 --format=%ci main
systemctl --user restart sidetone.service
```

Test 6 needs `adb` on the phone. Pair wireless debugging from the phone's
developer settings before leaving, and check:

```
~/Android/Sdk/platform-tools/adb devices
```

### 1. Can the replay be stopped?

The barge-in and the replay parts passed on 27 September. One part is left.

**Do.** With "interrupt on", ask for a long answer. Talk over it, then say
"sidetone, carry on". While the rest plays, say "sidetone, end the turn".

**Pass.** "Stopped." is the next thing said, and nothing is said twice.

**Evidence.** The journal has a `[stopped: ...]` line after the command. On
20 September "that's enough" ended a replay with no `[stopped: ...]` line, so
this phrase is not confirmed yet.

**At the desk.** The bridge's part passes in `bun test`: "a replay from carry
on is stopped, and the stop is heard at once" in `test/conversation.test.ts`.
The car checks whether whisper hears the phrase over the replay.

### 4. Does the answer arrive on the screen ahead of the voice?

The plain answer passed on 27 September. The tool call case is left.

**Do.** Ask for something that needs a tool, such as "what is in the todo
file", and watch the phone.

**Pass.** The words before the tool call and the words after it are two
bubbles, and each shows its time. When the voice is done, the text stands
once, not twice.

**Evidence.** `jq -c '{time,kind,bubble,text}' ~/.sidetone/screen/latest.jsonl`
shows two bubble numbers for the one turn.

**At the desk.** Both ends pass: "a tool call splits the answer" in
`test/turn.test.ts` gives the blocks, and `aToolCallSplitsAnAnswerIntoTwoBubbles`
in the app's `ConversationTest` makes two bubbles of them. The phone checks
what the screen shows.

### 7. Does cutting the microphone leave the conversation usable?

**Do.** Tap Mic, use Android Auto's voice input, tap Mic again, speak.

**Pass.** Android Auto hears you while the microphone is cut, and the bridge
hears you after it is open again: `[the room has a microphone track, TR_...]`
and then a `> ` line.

**At the desk.** The bridge's half passes in `test/drive.test.ts` (drive
test 7): after a cut and an open, the next utterance reaches the agent. The
car checks Android Auto's voice input and the new track.

### 9. How often would a shorter pause have cut a sentence?

Answered without a drive. From 19 to 26 September, 278 of 530 utterances held
a quiet of 400 ms or more that Chris talked through (to-do item 54). The turn
detector now runs in shadow mode, and test 16 collects its data.

### 10. Does the record know which setting was in force?

**Do.** Say "sidetone, male voice" or "sidetone, interrupt on" a few
turns in.

**Pass.** After the drive, the record has a `setting` line at the moment you
said it, and the settings on `/diagnostics` show the new value, not the one
the bridge started with:

```
grep '"setting"' ~/.sidetone/record.jsonl
curl -sk https://127.0.0.1:3100/diagnostics | python3 -c "import json,sys; print(json.load(sys.stdin)['settings']['ttsVoice'])"
```

**At the desk.** Passes in `test/drive.test.ts` (drive test 10), through the
same `/diagnostics` route. The car adds only whisper hearing the command.

### 11. Does "end the turn" with nothing running say so?

Before 19 September your own command counted as a barge-in, so this said
"Stopped." and dropped a hold with nothing behind it.

**Do.** With nothing playing, say "sidetone, end the turn".

**Pass.** "Nothing is running." Nothing else is said.

**At the desk.** Passes in `bun test`: "end the turn with no turn running
(9.4.8)" in `test/conversation.test.ts`. The car adds only whisper hearing the
command.

### 12. Does the audio go off and come back?

The control channel is one module now, and this is the message it handles
that no drive has tried.

**Do.** Tap the app's Audio button. Ask something. Tap it again. Ask again.

**Pass.** The answer arrives as text and nothing is spoken. After the second
tap the next answer is spoken. The journal has
`[the audio is off; the words carry on in the transcript]` and then
`[the audio is on]`, and the record has a `setting` line for each tap:

```
grep '"setting"' ~/.sidetone/record.jsonl | grep '"audio"'
```

**At the desk.** Passes in `test/drive.test.ts` (drive test 12), with the
button's `voice` message as the phone sends it. The car checks the button and
what Chris hears.

### 14. Does interrupting a finished answer stay quiet about it?

Before 19 September an interrupt of a turn whose answer had fully played
reported an earlier turn's held rest as unspoken.

**Do.** With "interrupt on": ask something, let the answer play out, then ask
a follow-up.

**Pass.** No `not spoken:` narration appears for the follow-up. The one time
it should appear is when you talk over an answer that is still playing.

**At the desk.** Both cases pass in `test/drive.test.ts` (drive test 14). The
car can skip this test.

### 8. Does the app come back after a restart?

Passed on 27 September. Run it again last, because test 13 needs the
restart. It ends this session, and everything learned above goes with it
unless it is already written down.

**Do.** With the app open, `systemctl --user restart sidetone.service`.

**Pass.** The app returns to "listening" without scanning a code, and the
next thing Chris says is heard.

**Fail.** If the app needs a touch, note the time and the status word on the
screen: "reconnecting", "disconnected" or "listening". That tells which
restart case the app misses: the service comes back on the same address, or
the session is lost.

**Evidence.** LiveKit runs in Docker apart from the bridge, so a bridge
restart does not end the phone's room. The app keeps the same room and sees
no disconnect. `JoiningTest` plays both restarts on its own clock: after a
LiveKit restart the app tries every 5 s and keeps the pairing, and after a
bridge restart nothing is tried. A refused pairing is the one end the app
gives up after. This test is the watched restart that `JoiningTest` cannot
give.

### 13. Does a phone that arrives while the engines warm get the words?

Extends test 8. The room used to be joined before the engines were
ready and the handlers attached after both, so a phone that reconnected in
that window got no protocol, no history, and its microphone cut was dropped.

**Do.** After the restart of test 8, reopen the app within five seconds,
before the bridge can hear.

**Pass.** The End the turn button is enabled at once and the earlier turns
appear on the screen, before `[turn` lines resume in the journal. The first
thing you say once the engines are warm is heard.

**Evidence.** The journal shows `bridge on https://…` and a participant
join before whisper's ready line; `/health` reports `engines.transcription`
false in that window and true after.

**At the desk.** The bridge's part passes in `bun scripts/warm-join.ts` and
`test/drive.test.ts` (drive test 13): the protocol, the settings and the
history arrive before the engines are warm, and the microphone cut lands. On
29 September the phone joined 20 s before the bridge was warm. After a
restart the history holds no turns, because the bridge keeps it in memory;
the earlier turns on the screen are the app's own lines (17.11.10). The
phone checks the button and those lines.

### 6. What holds Android Auto's audio? (needs adb)

Run this only if the fault returns. In call mode the car parks its own media
while the app is in the room (to-do item 27); that is expected. The fault is
Android Auto's voice input or media still blocked after the app leaves the
room. Test 5 passed on 27 September, so the fault did not show then.

**Do.** With the app out of the room and the fault showing:

```
adb shell dumpsys audio | grep -iE "mode|focus|usage"
adb shell am force-stop dev.crsmith.sidetone
adb shell dumpsys audio | grep -iE "mode|focus|usage"
```

**Settles.** A mode of `MODE_IN_COMMUNICATION` or a focus holder
`dev.crsmith.sidetone` in the first reading means the app did not let go.
Write both readings into the vault page.

### 15. Can the agent play a file and talk about it in the same turn?

**Failed, 27 September.** `POST /play` returned 202 for two files. The first
stopped at 26 s (`"whole":false`). The second has no `track` event: it never
played. The route reports success and drops the request. To-do item 61 holds
the fix. Rerun this test after it lands.

**Do.** Ask the agent to play a short file and to say one sentence about it in
the same turn.

**Pass.** The track and the sentence both play in full, one after the other,
with no retry. The record has a `track` event for the file that says it
finished.

**At the desk.** Passes in `test/drive.test.ts` (drive test 15): two tracks
asked for during a turn with the hold music on both play whole, then the
sentence. The test has one source, as the room has, and on the code before
item 61 it loses the second track, as the drive did. The car checks what
Chris hears.

### 16. Open microphone: turn detector data, and the names

The shadow turn detector (spec 18.16) writes a `turnGuess` line at each
tentative end. A guess is `resumed` when Chris talked through the pause, and
`ended` when the utterance ended, on a pause or on a release (`flush`). A
decision needs about 100 ends on a pause.

The same drive checks the vocabulary prompt of b139674: the speech to text
model gets the names in `sttVocabulary` as its initial prompt.

**Do.** Leave the microphone open for the whole drive and never touch hold to
talk. Talk naturally, with the hesitations, the "um"s and the pauses
mid-thought, and let each turn end on a pause. Say things that contain the
names: Sidetone, aleph, Cloud Chamber, Beamline, Voiceover, LiveKit, Kokoro,
Chatterbox, worktree. For example: "check the worktree for the Beamline job",
"is LiveKit or Kokoro slower", "what did aleph land in Cloud Chamber today".

**Look.** The `turnGuess` lines, counted by outcome and `endedBy`, then for
each threshold: `cutOff` is resumed guesses at or above it (Chris would have
been cut off), and `caught` is ended guesses at or above it (an early end
caught).

```
jq -sc '[.[] | select(.kind=="turnGuess")] as $g
 | ($g | group_by([.outcome, .endedBy]) | map({outcome: .[0].outcome, endedBy: .[0].endedBy, n: length})),
   ([0.5, 0.8, 0.9, 0.95][] as $t | {at: $t,
     cutOff: ($g | map(select(.outcome=="resumed" and .probability >= $t)) | length),
     caught: ($g | map(select(.outcome=="ended" and .probability >= $t)) | length)})' ~/.sidetone/record.jsonl
```

The output at 15:35 on 27 September. The drive of that day added 88 ends on
a pause, so the count is 89 of about 100:

```
[{"outcome":"ended","endedBy":"flush","n":2},{"outcome":"ended","endedBy":"pause","n":89},{"outcome":"resumed","endedBy":null,"n":104}]
{"at":0.5,"cutOff":31,"caught":69}
{"at":0.8,"cutOff":26,"caught":60}
{"at":0.9,"cutOff":21,"caught":54}
{"at":0.95,"cutOff":17,"caught":48}
```

The `heard` texts of the drive, to check the names. Set `-3 hours` to the
start of the drive:

```
jq -r --argjson since "$(date -d '-3 hours' +%s000)" 'select(.kind=="heard" and .at >= $since) | "\(.at/1000|localtime|strftime("%H:%M")) \(.endedBy) \(.text)"' ~/.sidetone/record.jsonl
```

**Settles.** When the `ended`/`pause` count nears 100, whether a threshold
exists with few `cutOff` and most `caught`: that decides if the detector
ends turns (to-do item 54). The heard texts settle the vocabulary prompt:
each name spelled as in the list passes; a name heard as something else
("side tone", "Alf", "live kit") fails, and the text goes into the vault
page.

### 17. Which speech model hears Chris best? (not this drive)

`docs/design.md`'s "Latency research, 18 September" compared five Whisper
models on synthetic voices and found no difference but one elided phrase. It
could not test Chris's voice through the phone. This test records it, and a
script scores it later on each model.

**Before.** Nothing. The card keeps each utterance while it runs, in
`~/.sidetone/heard/` as a wav with the text small.en wrote for it (spec 9.4.15,
18.14.4), whatever `keepHeardClips` says. The copies are his voice: delete them
once they are scored.

**Do.** Say "sidetone, read the card" or "sidetone, read the transcription
card". The bridge mutes, says "Round 1." and the first line, and says each
next line when he has said the one before. It does not pace itself on a
timer: a line he misses, he says again. Muted, no line acts. After the third
round the bridge says "That is the card. Listening." and unmutes. "sidetone,
unmute" stops it early. The transcription card, which the bridge reads from
`TRANSCRIPTION_CARD` in `src/commands.ts`, scores the speech that reaches the
agent and, in its last three lines, the wake word (item 67):

| # | Say | Want | Why |
|---|---|---|---|
| 1 | Drop that job. | speech | shortest line; a model drops or adds words on a short clip |
| 2 | Add a to-do item for the car cue. | speech | short command to the agent; "cue" is heard as "Queue" |
| 3 | What does item 67 say? | speech | question with a two-digit number |
| 4 | Open conversation.ts and find the readLine function. | speech | file name and code name, both out of the vocabulary |
| 5 | Is the LiveKit server still up on port 7880? | speech | a vocabulary word and a four-digit number |
| 6 | Land the transcription card job, then restart the service. | speech | two commands to the agent in one line; a job name |
| 7 | Check the worktree for changes before you rebase onto main. | speech | "worktree", heard as "work tree" before 26 September; git words |
| 8 | Read ADR 6 and tell me why Sidetone matches the sound of the wake word. | speech | "ADR", out of the vocabulary; "Sidetone" as a word, not the wake word |
| 9 | Ask Claude to build the APK and run bun test. | speech | "Claude", heard as "Cloud" and "Clod"; "APK" and "bun" |
| 10 | The answer took 2.4 seconds, and Kokoro used 350 milliseconds of that. | speech | a decimal and a three-digit number |
| 11 | Which Whisper model are we running right now? | speech | a question Chris asked, word for word from the record |
| 12 | When the road gets loud on the highway, keep each answer short and say the item number first. | speech | longest line; the ear must not end it on a pause |
| 13 | sidetone, end the turn | endTurn | the wake word, and the command that stops a turn |
| 14 | sidetone, male voice | maleVoice | the wake word; "male" was heard as "Mail" in the car |
| 15 | sidetone, recap | where | the wake word before one short word |

The card is 45 utterances, about six minutes. Before item 65 a card of
commands was read by hand: "sidetone, mute", the card three times with the
keep setting on, then "sidetone, unmute". Before item 67 the bridge read that
card of eleven commands and one sentence as well.

**Settles.** Nothing on the drive. After it, label each kept clip with its
line on the card. The journal names the line each utterance answered, in the
order the clips were kept:

```
journalctl --user -u sidetone.service --since "-3 hours" | grep "the card"
```

Then score each model on the labels, and the mean time a clip. A command
line scores by the count that `match` takes to the wanted command. A speech
line scores by the count of clips whose text is the line, after lower case
and with all but letters and digits removed, as `match` compares words: so
"conversation, TS" is right for "conversation.ts" and "Car Queue" is wrong
for "car cue". "sixty-seven" is wrong for "67", because the agent reads the
digits. A clip kept at the tentative end (18.4) that is only part of a line
gets no label of its own.

### If it goes wrong mid-drive

| Trouble | What works |
|---|---|
| The bridge stops hearing | close the app and open it again, so it publishes a new track |
| An answer or a replay will not stop | "sidetone, end the turn", or its one-word form "sidetone, sharp" |
| Interrupting feels wrong | "sidetone, interrupt off" |
| Nothing at all reaches him | the typing box still works; the conversation is the same one |

### What this does not test

The engine swap by voice ("fast voice" / "clone voice") is not built; the
engine is `ttsEngine` in the config and needs a restart. The cloned voice's
garbling is not measured: note the exact sentence when it happens.
