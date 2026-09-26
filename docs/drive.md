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

Write each verdict into `[[Voice Bridge Car Test 4]]` in the vault as it lands.
The drive ends when every test below has a verdict, or a reason it was skipped.

The commits of 19 September add six more tests, numbered 9 to 14, in
[`drive-tests-19-september.md`](drive-tests-19-september.md).

## Before the car

The Android Auto fault (test 6) needs `adb` on the phone. Pair wireless
debugging from the phone's developer settings before leaving, and check:

```
~/Android/Sdk/platform-tools/adb devices
```

The live unit runs the code it was started with. Restart it before the drive,
or the drive tests yesterday's build:

```
systemctl --user restart sidetone.service
```

## New since the last drive

| Say or see | What it does |
|---|---|
| a question over the answer, with "interrupt on" | stops the answer, answers the question; "carry on" says the rest, and the rest can now be stopped |
| "sidetone, end the turn" during "carry on" | stops the replay: "Stopped." |
| "sidetone, stats" | says the round trip and how it split: the agent, the first sentence, the voice |
| "interrupt on", "tones off", "male voice" | kept in the config file now; a restart no longer forgets them |
| "sidetone, music off", "sidetone, music on" | the hold music off or on: "Music off." or "Music on."; kept in the config file as `holdMusic`, and shown in `/diagnostics` and the record. Not on the muted list. Steps 10 and 11 of the card |
| the same three, then `/diagnostics` or the record | say the setting in force now, not the one the bridge started with; the record carries a `setting` line at the moment of the change |
| the phone's screen | the app shows the answer word by word in one bubble for each block, with the clock time; the web page shows it a sentence at a time |
| "working" beside the connection state, in the app | a slow pulse while a turn or an aleph job runs, with the audio cut too. Red "stalled" means the bridge sent nothing for 15 seconds while it said it worked. It is off when the agent is idle (spec 17.11) |
| The screen log, sent by the app on its own | appends what the app showed to `~/.sidetone/screen/<id>.jsonl`, one file for each conversation. Read it with `jq -c '{time,kind,bubble,text}' ~/.sidetone/screen/latest.jsonl`. The journal has `screen log at` (spec 14.11, 17.12) |
| a screenshot with the power and volume-down keys, with the app on the screen | the app sends the image; the bridge writes it to `~/.sidetone/screenshots/<id>.jpg`, and `latest.jpg` links to the newest. The journal has `screenshot at`. Say what it shows as usual (spec 14.12, 17.18) |
| the journal, `begun at the tentative end` | the transcription started during the pause, so the round trip no longer waits for it |
| the journal, `N false ends` on a `> ` line | a quiet of 400 ms that you then talked through. Each one is where a shorter pause would have cut you off; the total decides whether a turn detector is worth building |
| swiping the app away | leaves the room; the bridge logs `[the room lost a microphone track]` |
| "Leave" in the gear menu | leaves the room and keeps the app open: the dot goes grey, the word is "left", the transcript stays, and the car's own music should come back. "Rejoin" is where the hold to talk button was. The bridge logs `[the room lost a microphone track]`, and after 30 s the line of spec 18.9.2 once (spec 17.11.10) |

## 1. Can the replay be stopped?

This was the worst fault of the last drive: after "carry on", nothing could
stop the rest of the answer, and every "Stopped." queued behind it.

**Do.** With "interrupt on", ask for a long answer. Talk over it with a real
question; it should stop and answer you. Then say "sidetone, carry on".
While the rest plays, say "okay, that's enough".

**Pass.** The replay stops at once, your words start a new turn, and nothing
is said twice.

**Evidence.** `[stopped: Chris started talking]`,
then `[turn N]` within a few seconds, and a `not spoken:` narration naming the
rest. No sentence appears twice in the journal.

**Then.** Say "sidetone, carry on" again, barge in, and say "sidetone,
end the turn". Pass is "Stopped." as the next thing said.

## 2. Is the interrupt mode still on after a restart?

**Do.** Say "sidetone, interrupt on". Later, when the drive restarts the
service (test 8), talk over an answer.

**Pass.** It interrupts, and `~/.sidetone/config.json` holds
`"interruptOnSpeech": true`.

## 3. Where does the round trip go?

**Do.** After a few ordinary turns, say "sidetone, stats".

**Pass.** It says the last round trip, the pause, and then the agent, the
first sentence and the voice, in seconds. `~/.sidetone/record.jsonl` has
the same on each `answered` line as `agentMs`, `sentenceMs`, `synthesisMs`.

**Then.** Count the journal's `begun at the tentative end` against the
`> ` lines. That fraction is how often the pause guess was right in a car;
at the desk it was every time.

## 4. Does the answer arrive on the screen ahead of the voice?

**Do.** Ask something that takes a few sentences, and watch the phone. Then
ask for something that needs a tool, such as "what is in the todo file", and
watch again.

**Pass.** In the app the answer grows word by word, ahead of the voice. When
the voice is done the same text stands once, not twice. The words before the
tool call and the words after it are two bubbles, and each shows its time. On
the web page the answer grows a sentence at a time in one line.

## 5. Does the app let go of the room when it is swiped away?

**Do.** With the app in a room, swipe it out of Recents.

**Pass.** The journal shows `[the room lost a microphone track, TR_...]`
within seconds, and Android Auto's own voice input works again.

**Evidence.** If the track is gone and Android Auto still cannot hear, the
room was not what held it: go to test 6.

## 6. What holds Android Auto's audio? (needs adb)

The app took both the car's voice input and its media output on the last
drive, and leaving the app did not give them back. The suspect is the room
itself: LiveKit joins it as a phone call (`MODE_IN_COMMUNICATION`), and a
car in a call parks its own assistant and media.

**Do.** With the app in a room and the fault showing:

```
adb shell dumpsys audio | grep -iE "mode|focus|usage"
adb shell am force-stop dev.crsmith.sidetone
adb shell dumpsys audio | grep -iE "mode|focus|usage"
```

**Pass.** The first reading shows `MODE_IN_COMMUNICATION` and a focus holder
`dev.crsmith.sidetone`; the second shows `NORMAL` and no holder, and the
car's audio is back. That confirms the suspect, and the change is one line
(`AudioType.MediaAudioType` in `LiveKit.create`), built after the drive.

**Fail.** Mode `NORMAL` and no holder while the fault shows means the room is
not it; write down everything the first reading said.

## 7. Does cutting the microphone leave the conversation usable?

Carried over: last time the track went away and Android Auto still could not
hear. Repeat after test 6 has an answer.

**Do.** Tap "Cut the microphone", use Android Auto's voice input, reopen it,
speak.

**Pass.** Android Auto hears you while it is cut, and the bridge hears you
after it is reopened: `[the room has a microphone track]` and then a `> `
line.

## 15. Can the agent play a file and talk about it in the same turn?

`/play` used to fight the agent's own speech and the hold music. On 22
September a track stopped a second in, when the agent said one sentence about
it. A second try met `the bridge is speaking or playing` for two minutes. Since
912e3ae and 1ec210b, `Mouth.play` waits for a free source, and a sentence waits
for the track. Only a live try is left.

**Do.** Ask the agent to play a short file and to say one sentence about it in
the same turn.

**Pass.** The track and the sentence both play in full, one after the other,
with no retry. The record has a `track` event for the file that says it
finished.

## 8. Does the app come back after a restart? (last)

Run this one last: it ends this session, and everything learned above goes
with it unless it is already written down.

**Do.** With the app open, `systemctl --user restart sidetone.service`.

**Pass.** The app returns to "listening" without scanning a code, and the
next thing Chris says is heard. Passed on the last drive in five seconds; this
time also check test 2.

## 15. Does the canceller hold with the app as media? (branch `focus`)

The branch plays the bridge as media and takes no audio focus (to-do item
27). Barge-in depends on the echo canceller, and the car is the doubtful case.

**Do.** At the desk, with the branch installed and the phone on its
loudspeaker at full media volume, say "sidetone, mute" and run the check.
Then do the same in the car, on Bluetooth. Then play music from another app
and talk over an answer.

```
bun scripts/echo-check.ts
```

**Pass.** `PASS` both times, the other app's music keeps playing while the
bridge is in the room, and a barge-in still stops the answer.

**Evidence.** The check's output; `echo` lines in the record
(`jq -c 'select(.kind=="echo")' ~/.sidetone/record.jsonl`).

**Answered, 23 and 24 September 2026.** Media mode: no. In the car the
microphone brought the whole passage back, 14.9 s of it at peak 0.54. Call
mode: yes. The next morning the same check over Bluetooth SCO to the car, at
full volume, with the microphone open and the capture live, brought nothing
back, and Chris heard the passage. Call mode routes the voice as a call and the
car's own canceller does the work.

Run `bun scripts/echo-check.ts` in the car again before anything about the
audio setup changes. `bun scripts/audio-setup.ts` changes it without a build
now, and the record names which setup each reading was taken with.

**If it fails.** Tap "Update the app" in the app: the bridge serves the build
from `main`, which is still in call mode.

**Fail.** If the app needs a touch, note the time and the status word on the
screen: `RECONNECTING`, `UNREACHABLE` or `LISTENING`. That tells which restart
case the app misses: the service comes back on the same address, or the
session is lost.

**Evidence.** LiveKit runs in Docker apart from the bridge, so a bridge
restart does not end the phone's room. The app keeps the same room and sees no
disconnect. On 21 September no restart after 07:35 needed a touch.
`JoiningTest` plays both restarts on its own clock: after a LiveKit restart
the app tries every 5 s and keeps the pairing, and after a bridge restart
nothing is tried. A refused pairing is the one end the app gives up after.
This test is the watched restart that `JoiningTest` cannot give.

## If it goes wrong mid-drive

| Trouble | What works |
|---|---|
| The bridge stops hearing | close the app and open it again, so it publishes a new track |
| An answer will not stop | "sidetone, sharp" |
| A replay will not stop | "sidetone, end the turn" — and that is a fail for test 1, write it down |
| Interrupting feels wrong | "sidetone, interrupt off" |
| Nothing at all reaches him | the typing box still works; the conversation is the same one |

## What this does not test

The engine swap by voice ("fast voice" / "clone voice") is not built; the
engine is `ttsEngine` in the config and needs a restart. The cloned voice's
garbling is not measured: note the exact sentence when it happens.
