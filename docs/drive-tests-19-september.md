# The tests the commits of 19 September add to the drive

Six tests on top of the tests in [`drive.md`](drive.md). Each one is
something Chris does in the car and the bridge checks from the journal, the
record or `/diagnostics`. Read a test out loud before it starts. Write each
verdict into the vault page "Voice Bridge Car Test 4" with the others.

## 9. How often would a shorter pause have cut a sentence?

Answered without a drive. From 19 to 26 September, 278 of 530 utterances held
a quiet of 400 ms or more that Chris talked through (to-do item 54). The turn
detector now runs in shadow mode, and drive.md test 16 collects its data.

## 10. Does the record know which setting was in force?

**Do.** Say "sidetone, male voice" or "sidetone, interrupt on" a few
turns in.

**Pass.** After the drive, the record has a `setting` line at the moment you
said it, and the settings on `/diagnostics` show the new value, not the one
the bridge started with:

```
grep '"setting"' ~/.sidetone/record.jsonl
curl -sk https://127.0.0.1:3100/diagnostics | python3 -c "import json,sys; print(json.load(sys.stdin)['settings']['ttsVoice'])"
```

## 11. Does "end the turn" with nothing running say so?

Before 19 September your own command counted as a barge-in, so this said
"Stopped." and dropped a hold with nothing behind it.

**Do.** With nothing playing, say "sidetone, end the turn".

**Pass.** "Nothing is running." Nothing else is said.

## 12. Does the audio go off and come back?

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

## 13. Does a phone that arrives while the engines warm get the words?

Extends drive.md test 8. The room used to be joined before the engines were
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

## 14. Does interrupting a finished answer stay quiet about it?

Before 19 September an interrupt of a turn whose answer had fully played
reported an earlier turn's held rest as unspoken.

**Do.** With "interrupt on": ask something, let the answer play out, then ask
a follow-up.

**Pass.** No `not spoken:` narration appears for the follow-up. The one time
it should appear is when you talk over an answer that is still playing.
