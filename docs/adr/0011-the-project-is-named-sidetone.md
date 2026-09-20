# The project is named Sidetone

The project was called "voice bridge", a description rather than a name. On
18 September 2026 Chris asked for a name in the register of Cloud Chamber and
Beamline: a noun that names the mechanism. Sidetone is the tone a telephone
feeds back into the earpiece so the line never sounds dead. The program exists
so a long turn never sounds like a dropped call, which is the same job. Chosen
20 September 2026.

## Considered options

- **Earshot.** The plain word: the phone, the car, the machine at home. Warm,
  and easy to say to another person. Several small products already use it,
  and "within earshot" is a phrase Chris might say to the agent.
- **Voiceband.** The 300-3400 Hz band a phone line carries. Exact, and cold.
- **Nearfield.** Everyone reads NFC. Wrong signal.
- **Sidetone.** Chosen. It names one mechanism and it is the truest one. As a
  wake phrase it has the best onset of the four: a hard /s/ after "hey", and
  nobody says it by accident.

## Consequences

The names a person sees change: the titles, the app name, the package name,
the unit descriptions. The words the code uses do not: **the bridge**, the
agent, the client, the room stay as `CONTEXT.md` has them.

The runtime identity stays until each piece is moved on purpose, because each
one breaks a live thing when it moves: `~/.voice-bridge`, the `VOICE_BRIDGE_*`
variables, the unit file names, the Android package id, the credential keys,
the checkout directory.

The wake word stays "hey bridge". `docs/next.md` records it as settled, found
24 of 24 on the bench and never missed on a drive, and spec 18.8 says change it
only when it collides. "hey sidetone" is the candidate when it does.
