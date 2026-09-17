# Speech stays on this machine, with no cloud fallback

Speech-to-text, text-to-speech and wake-word matching are all local, in every
mode, at all times. This removes the per-use cost, keeps a conversation that
runs all day private, and removes a network hop that a car connection would
make slow. Each engine sits behind an interface that accepts local engines
only: no cloud engine, and no cloud fallback for a local engine that fails.

## Consequences

The GPU is a hard dependency, not an optimisation. If the machine ever does
other GPU work, the models get smaller; there is nothing to fall back to.
