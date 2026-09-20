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

The runtime identity moved the same day, all of it, so the old name is gone:
`~/.sidetone`, the `SIDETONE_*` variables, the `sidetone*` units, the Android
package `dev.crsmith.sidetone` (a new app on the phone, paired again), the
credential keys (the browser pairs again), the checkout `~/sidetone`, the
GitHub repository `crsmithdev/sidetone`.

The wake word is the single word "sidetone". "hey bridge" was settled
(`docs/next.md`), but the name is the wake word now, and one word is quicker
in a car. The corpus was rerun for it: small.en writes "side tone" a third of
the time, and "cytone", "sigh tone", "sight tone", "sitone" when the /d/ goes
under road noise, so those are the variants. 93 spellings, 5 not reached, 4 of
them on the run-together phrase. "hey bridge" reached 74 of 74. A drive says
whether that gap is felt.
