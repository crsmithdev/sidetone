# The drive card

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

## What is open

The drive of 27 September passed tests 2, 3, 5 and 8, and most of 1 and 4.
Test 15 failed. The vault page has each verdict. These are open:

| Test | What is left |
|---|---|
| 1 | "sidetone, end the turn" during a replay |
| 4 | an answer with a tool call: two bubbles |
| 7 | the Mic button and Android Auto's voice input |
| 9 to 14 | all, in [`drive-tests-19-september.md`](drive-tests-19-september.md) |
| 6 | only if Android Auto's audio stays blocked after the app leaves the room |
| 15 | a rerun after to-do item 61 lands |
| 16 | a drive with the microphone open, for the turn detector and the names |

Run them in this order: 1, 4, 7, then 10, 11, 12 and 14, then the restart of
test 8 with test 13 last. Test 16 changes how test 1 behaves, so ask Chris at
the start: run test 16 on the way back, or on another drive.

## Before the car

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

## 1. Can the replay be stopped?

The barge-in and the replay parts passed on 27 September. One part is left.

**Do.** With "interrupt on", ask for a long answer. Talk over it, then say
"sidetone, carry on". While the rest plays, say "sidetone, end the turn".

**Pass.** "Stopped." is the next thing said, and nothing is said twice.

**Evidence.** The journal has a `[stopped: ...]` line after the command. On
20 September "that's enough" ended a replay with no `[stopped: ...]` line, so
this phrase is not confirmed yet.

## 4. Does the answer arrive on the screen ahead of the voice?

The plain answer passed on 27 September. The tool call case is left.

**Do.** Ask for something that needs a tool, such as "what is in the todo
file", and watch the phone.

**Pass.** The words before the tool call and the words after it are two
bubbles, and each shows its time. When the voice is done, the text stands
once, not twice.

**Evidence.** `jq -c '{time,kind,bubble,text}' ~/.sidetone/screen/latest.jsonl`
shows two bubble numbers for the one turn.

## 7. Does cutting the microphone leave the conversation usable?

**Do.** Tap Mic, use Android Auto's voice input, tap Mic again, speak.

**Pass.** Android Auto hears you while the microphone is cut, and the bridge
hears you after it is open again: `[the room has a microphone track, TR_...]`
and then a `> ` line.

## 8. Does the app come back after a restart? (last)

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

## 6. What holds Android Auto's audio? (needs adb)

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

## 15. Can the agent play a file and talk about it in the same turn?

**Failed, 27 September.** `POST /play` returned 202 for two files. The first
stopped at 26 s (`"whole":false`). The second has no `track` event: it never
played. The route reports success and drops the request. To-do item 61 holds
the fix. Rerun this test after it lands.

**Do.** Ask the agent to play a short file and to say one sentence about it in
the same turn.

**Pass.** The track and the sentence both play in full, one after the other,
with no retry. The record has a `track` event for the file that says it
finished.

## 16. Open microphone: turn detector data, and the names

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

## If it goes wrong mid-drive

| Trouble | What works |
|---|---|
| The bridge stops hearing | close the app and open it again, so it publishes a new track |
| An answer or a replay will not stop | "sidetone, end the turn", or its one-word form "sidetone, sharp" |
| Interrupting feels wrong | "sidetone, interrupt off" |
| Nothing at all reaches him | the typing box still works; the conversation is the same one |

## What this does not test

The engine swap by voice ("fast voice" / "clone voice") is not built; the
engine is `ttsEngine` in the config and needs a restart. The cloned voice's
garbling is not measured: note the exact sentence when it happens.
