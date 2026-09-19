# The drive card

The open questions about this bridge, and the test that settles each one. Every
test is something Chris does in the car and the bridge checks from the journal,
so the answer is evidence rather than an impression.

Read a test out loud before it starts, one at a time. Gather the evidence
yourself: `journalctl --user -u voice-bridge.service --since "-10 min"` is the
whole record of the drive, `~/.voice-bridge/record.jsonl` holds every utterance
and its measurements, and `adb` (at `~/Android/Sdk/platform-tools/adb`, not on
the PATH) reaches the phone once it is paired over wireless debugging. Never
ask Chris for something a command answers.

Write each verdict into `[[Voice Bridge Car Test 4]]` in the vault as it lands.
The drive ends when every test below has a verdict, or a reason it was skipped.

## Before the car

The Android Auto fault (test 6) needs `adb` on the phone. Pair wireless
debugging from the phone's developer settings before leaving, and check:

```
~/Android/Sdk/platform-tools/adb devices
```

The live unit runs the code it was started with. Restart it before the drive,
or the drive tests yesterday's build:

```
systemctl --user restart voice-bridge.service
```

## New since the last drive

| Say or see | What it does |
|---|---|
| a question over the answer, with "interrupt on" | stops the answer, answers the question; "carry on" says the rest, and the rest can now be stopped |
| "hey bridge, end the turn" during "carry on" | stops the replay: "Stopped." |
| "hey bridge, stats" | says the round trip and how it split: the agent, the first sentence, the voice |
| "interrupt on", "tones off", "male voice" | kept in the config file now; a restart no longer forgets them |
| the same three, then `/diagnostics` or the record | say the setting in force now, not the one the bridge started with; the record carries a `setting` line at the moment of the change |
| the phone's screen | the answer arrives a sentence at a time, before the voice reaches it |
| the journal, `begun at the tentative end` | the transcription started during the pause, so the round trip no longer waits for it |
| the journal, `N false ends` on a `> ` line | a quiet of 400 ms that you then talked through. Each one is where a shorter pause would have cut you off; the total decides whether a turn detector is worth building |
| swiping the app away | leaves the room; the bridge logs `[the room lost a microphone track]` |

## 1. Can the replay be stopped?

This was the worst fault of the last drive: after "carry on", nothing could
stop the rest of the answer, and every "Stopped." queued behind it.

**Do.** With "interrupt on", ask for a long answer. Talk over it with a real
question; it should stop and answer you. Then say "hey bridge, carry on".
While the rest plays, say "okay, that's enough".

**Pass.** The replay stops at once, your words start a new turn, and nothing
is said twice.

**Evidence.** `[stopped: Chris started talking]`,
then `[turn N]` within a few seconds, and a `not spoken:` narration naming the
rest. No sentence appears twice in the journal.

**Then.** Say "hey bridge, carry on" again, barge in, and say "hey bridge,
end the turn". Pass is "Stopped." as the next thing said.

## 2. Is the interrupt mode still on after a restart?

**Do.** Say "hey bridge, interrupt on". Later, when the drive restarts the
service (test 8), talk over an answer.

**Pass.** It interrupts, and `~/.voice-bridge/config.json` holds
`"interruptOnSpeech": true`.

## 3. Where does the round trip go?

**Do.** After a few ordinary turns, say "hey bridge, stats".

**Pass.** It says the last round trip, the pause, and then the agent, the
first sentence and the voice, in seconds. `~/.voice-bridge/record.jsonl` has
the same on each `answered` line as `agentMs`, `sentenceMs`, `synthesisMs`.

**Then.** Count the journal's `begun at the tentative end` against the
`> ` lines. That fraction is how often the pause guess was right in a car;
at the desk it was every time.

## 4. Does the answer arrive on the screen ahead of the voice?

**Do.** Ask something that takes a few sentences, and watch the phone.

**Pass.** The answer grows a sentence at a time before the voice finishes,
and when the voice is done the same text stands once, not twice.

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
adb shell am force-stop dev.crsmith.voicebridge
adb shell dumpsys audio | grep -iE "mode|focus|usage"
```

**Pass.** The first reading shows `MODE_IN_COMMUNICATION` and a focus holder
`dev.crsmith.voicebridge`; the second shows `NORMAL` and no holder, and the
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

## 8. Does the app come back after a restart? (last)

Run this one last: it ends this session, and everything learned above goes
with it unless it is already written down.

**Do.** With the app open, `systemctl --user restart voice-bridge.service`.

**Pass.** The app returns to "listening" without scanning a code, and the
next thing Chris says is heard. Passed on the last drive in five seconds; this
time also check test 2.

## If it goes wrong mid-drive

| Trouble | What works |
|---|---|
| The bridge stops hearing | close the app and open it again, so it publishes a new track |
| An answer will not stop | "hey bridge, sharp" |
| A replay will not stop | "hey bridge, end the turn" — and that is a fail for test 1, write it down |
| Interrupting feels wrong | "hey bridge, interrupt off" |
| Nothing at all reaches him | the typing box still works; the conversation is the same one |

## What this does not test

The engine swap by voice ("fast voice" / "clone voice") is not built; the
engine is `ttsEngine` in the config and needs a restart. The cloned voice's
garbling is not measured: note the exact sentence when it happens.
