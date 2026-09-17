# The agent is permissive, behind a small gate

Driving by voice is worthless if every step asks permission, so the agent runs
permissive. A gated action happens only after Chris speaks the agreement word,
which is "continue" and deliberately not "yes": a specific word cannot come from
a reflex or a mis-transcription, and the gate fails closed. The bridge reads back
what it is about to do before it asks.

## Consequences

One action is gated today: clearing the context, which kills the process the
conversation lives in. Everything else about what the agent may do comes from
the project's own instructions file, not from the bridge — the bridge does not
put the agent in a worktree, and the container that the specification asks for,
to isolate the file system and the processes, is not built.
