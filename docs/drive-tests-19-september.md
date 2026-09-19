# The tests the commits of 19 September add to the drive

Six tests for the next drive, on top of the eight in [`drive.md`](drive.md).
Each one is something Chris does in the car and the bridge checks from the
journal, the record or `/diagnostics`. Read a test out loud before it starts.
Write each verdict into `[[Voice Bridge Car Test 4]]` in the vault with the
others.

The live unit runs `f67eaf1`, restarted at 11:49 on 19 September. Restart it
only if something lands after that. Before leaving, check the five-hour rate
limit: it read 89 percent during the last test run at the desk, and a drive
with no headroom tests nothing.

```
systemctl --user show voice-bridge.service -p ExecMainStartTimestamp
```

## 9. How often would a shorter pause have cut a sentence?

This is the number that decides whether a turn detector is worth building.
The research of 18 September ranked it third on a guess: it would cut the
1500 ms pause to about 400 on turns that sound complete, and nobody knew how
often Chris pauses that long mid-sentence in a car.

**Do.** Nothing extra. Talk the way you would on any drive, with the pauses
you take mid-sentence to think.

**Pass.** There is no pass. The journal's `> ` lines carry `N false ends` on
the utterances where a quiet of 400 ms was followed by more speech. After the
drive:

```
curl -sk https://127.0.0.1:3100/diagnostics | python3 -c "import json,sys; d=json.load(sys.stdin)['summary']; print(d['utterances'], d['falseEnds'], d['withFalseEnds'])"
```

Few false ends across many utterances means the detector would have been
right; many means it would cut you off, and it is not built.

## 10. Does the record know which setting was in force?

**Do.** Say "hey bridge, male voice" or "hey bridge, interrupt on" a few
turns in.

**Pass.** After the drive, the record has a `setting` line at the moment you
said it, and the settings on `/diagnostics` show the new value, not the one
the bridge started with:

```
grep '"setting"' ~/.voice-bridge/record.jsonl
curl -sk https://127.0.0.1:3100/diagnostics | python3 -c "import json,sys; print(json.load(sys.stdin)['settings']['ttsVoice'])"
```

## 11. Does "end the turn" with nothing running say so?

Until today your own command counted as a barge-in, so this said "Stopped."
and dropped a hold with nothing behind it.

**Do.** With nothing playing, say "hey bridge, end the turn".

**Pass.** "Nothing is running." Nothing else is said.

## 12. Does the voice go off and come back?

The control channel is one module now, and this is the message it handles
that no drive has tried.

**Do.** Tap the app's voice toggle. Ask something. Tap it back. Ask again.

**Pass.** The bridge says "the voice is off; the words carry on in the
transcript" as a note on the screen; the answer arrives as text and nothing
is spoken; after the toggle the next answer is spoken. The journal has
`[the voice is off; the words carry on in the transcript]` and then
`[the voice is on]`.

## 13. Does a phone that arrives while the engines warm get the words?

Extends test 8. The room used to be joined before the engines were ready and
the handlers attached after both, so a phone that reconnected in that window
got no protocol, no history, and its microphone cut was dropped.

**Do.** After the restart of test 8, reopen the app within five seconds,
before the bridge can hear.

**Pass.** The Stop button is enabled at once and the earlier turns appear on
the screen, before `[turn` lines resume in the journal. The first thing you
say once the engines are warm is heard.

**Evidence.** The journal shows `bridge on https://…` and a participant
join before whisper's ready line; `/health` reports `engines.transcription`
false in that window and true after.

## 14. Does interrupting a finished answer stay quiet about it?

Until today an interrupt of a turn whose answer had fully played reported an
earlier turn's held rest as unspoken.

**Do.** With "interrupt on": ask something, let the answer play out, then ask
a follow-up.

**Pass.** No `not spoken:` narration appears for the follow-up. The one time
it should appear is when you talk over an answer that is still playing.

## What changed under test 1

The barge-in cut is the ear's word through a new route, and the room's
speaker lives in the transport now. The journal line is
`[stopped: Chris started talking]` with no millisecond count. Test 1's
evidence in `drive.md` says the same.
