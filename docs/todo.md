# To do

Chris's list of things to build or look at. Add to the end. Delete an item
when it ships, and say where in the commit message.
[`docs/drive.md`](drive.md) holds the open car tests; this file holds the rest.

## 1. The app ignores the volume setting

Noted 21 September 2026. Not investigated yet.

| Where | What Chris sees |
|---|---|
| Car | The car volume control works. |
| Phone alone | The volume setting has little or no effect. |
| Desk, from the bridge machine | The voice plays at full level, even with the volume all the way down. |

Find out how the audio path takes its level. A search of the `.ts` and `.kt`
files finds only `cueVolume`, which scales the cues, and the gain in
`src/audio.ts`. It finds no code that reads a system or phone volume.

Done when the voice follows the volume control on the phone alone, in the car,
and on the bridge machine.

## 2. Push to talk, or hold to talk, in the app

Noted 21 September 2026. Not designed yet.

Today Chris cuts and uncuts the microphone. The spoken commands `mute` and
`unmute` do it (9.5), and the app has a muted track. Chris wants a button in
the app that does the same job by touch.

Two forms are possible. Chris has not chosen one.

| Form | The microphone is open |
|---|---|
| Hold to talk | While Chris holds the button. |
| Push to talk | From one press until the next press. |

Decide first whether the button replaces the mute command or sits beside it,
and what barge-in does while the microphone is closed (9.5).
