# The drive card

The open questions about this bridge, and the test that settles each one. Every
test is something Chris does in the car and the bridge checks from the journal,
so the answer is evidence rather than an impression.

Read a test out loud before it starts, one at a time. Gather the evidence
yourself: `journalctl --user -u voice-bridge.service --since "-10 min"` is the
whole record of the drive, `~/.voice-bridge/record.jsonl` holds every utterance
and its measurements, and `adb` reaches the phone. Never ask Chris for something
a command answers.

Write each verdict into `[[Voice Bridge Car Test 3]]` in the vault as it lands.
The drive ends when every test below has a verdict, or a reason it was skipped.

## New since the last drive, and worth trying

| Say or tap | What it does |
|---|---|
| "hey bridge, interrupt on" / "interrupt off" | a question mid-answer stops the answer, rather than being refused |
| "hey bridge, sharp" | ends the turn, one word; "stop" and "cancel" work too |
| "hey bridge, carry on" | says the rest of an answer you talked over |
| Cut the voice (button) | the bridge stops speaking; the words keep arriving in the transcript |

The bridge now says three things it used to keep to itself: that it can hear
nothing, that a wake word arrived with no command, and that background work has
finished. The voice is a cloned one and a sentence costs about three seconds;
`ttsEngine: "kokoro"` in the config buys that back at the cost of the voice.

## 1. Is interrupting better than holding?

**Do.** Say "hey bridge, interrupt on". Ask for something that takes a long
answer. Talk over it with a real question.

**Pass.** The answer stops, the question is answered, and nothing says "I am
still on the last one".

**Evidence.** `[stopped: Chris started talking, Nms after it was noticed]`, then
a new turn within about five seconds. No `[the process took the interrupt]` line
means the old turn ended by itself and nothing in flight was thrown away.

**Then.** Say "hey bridge, carry on" and check the rest of the dropped answer
arrives, once. Chris decides whether `interruptOnSpeech` becomes the default.

## 2. Does cutting the microphone free it for Android Auto?

**Do.** With the app open, tap "Cut the microphone". Use Android Auto's voice
input.

**Pass.** Android Auto hears him.

**Evidence.** The journal must carry `[the room lost a microphone track, TR_...]`
at the moment of the tap. If it does and Android Auto still fails, the published
track was never the cause: run
`adb shell dumpsys audio | grep -A5 RecordActivityMonitor` and look for a record
session the app still holds. The foreground service is the next suspect.

## 3. Can the bridge be made deaf again?

**Do.** Cut the microphone and reopen it, a few seconds apart. Then cut and
reopen it twice inside one second.

**Pass.** The bridge hears him after each.

**Evidence.** Every cut and reopen writes `[the room lost a microphone track]`
or `[the room has a microphone track]`. If it goes deaf, the next line names the
fault: `no audio from the phone for Ns` means no track arrived at all;
`the phone's microphone has carried no sound at all for Ns` means a track
arrived and captures nothing, which points at the app rather than the bridge.

**Then.** For the second fault, `adb shell dumpsys audio` says whether the app
holds a record session after it republished.

## 4. Does the phone's own volume control reach the bridge?

**Do.** Away from Android Auto, with the bridge speaking, press volume down.

**Pass.** The bridge gets quieter.

**Then.** Note which stream the phone thinks it is. A volume dialog that says
"Call" rather than "Media" is the answer to why it behaves oddly.

## 5. Is the cloned voice worth three seconds a sentence?

**Do.** Talk for several turns and listen to the gap before each sentence.

**Pass.** There is no pass; this is a preference. Ask for it plainly.

**Evidence.** "hey bridge, stats" reads the round trip aloud. The journal's
`[Ns heard ... read in Nms]` lines hold the rest.

**Then.** `ttsEngine: "kokoro"` is about fifteen times faster and sounds like a
stock voice. After changing it, `bun src/main.ts warm` remakes the kept
sentences, which takes eighty seconds.

## 6. Does a cut voice leave a usable conversation?

**Do.** Tap "Cut the voice". Ask something.

**Pass.** Nothing is spoken and the answer arrives in the transcript.

**Then.** Tap it again and check the speech comes back.

## 7. Does the app come back after a restart? (last)

Run this one last: it ends this session, and everything learned above goes with
it unless it is already written down.

**Do.** With the app open, `systemctl --user restart voice-bridge.service`.

**Pass.** The app returns to "listening" without scanning a code, and the next
thing Chris says is heard.

**Evidence.** After the start line, `[the room has a microphone track, TR_...]`,
then a heard utterance. A client stuck on "disconnected" is the failure; note
how long it stays there.

## If it goes wrong mid-drive

| Trouble | What works |
|---|---|
| The bridge stops hearing | close the app and open it again, so it publishes a new track |
| An answer will not stop | "hey bridge, sharp" |
| Interrupting feels wrong | "hey bridge, interrupt off" |
| Nothing at all reaches him | the typing box still works; the conversation is the same one |

## What this does not test

The in-app reset of item 11 is not built, and the buttons above are only on the
phone once the app is built and installed from `android/`.
