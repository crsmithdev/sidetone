# Commands are matched by sound, against what the engine actually wrote

A speech engine returns a word that sounded like the one Chris said, not the one
he said: "male voice" comes back as *Mail Voice*, "end the turn" elides to *in
the turn*, "never mind" arrives as one word. Matching the spelling ships
commands that are broken in the car and nowhere else, so the matcher forgives
spelling, and each command is checked against a recorded corpus of what the
model that ships actually wrote for that phrase under noise.

## Consequences

Adding a command means adding the phrase and then regenerating the corpus. The
corpus is a fixture in the repository; the tests need no GPU and no audio.
