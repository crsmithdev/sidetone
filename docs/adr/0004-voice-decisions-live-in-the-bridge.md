# Every voice decision lives in the bridge, not in the agent

The agent reads and writes text and knows nothing about audio, so Claude Code
needs no change to be driven by voice, and a voice decision can change without
touching the agent. The one piece that looked like an exception, the narration
that fills the silence while a tool runs, was specified as a hook inside aleph;
Claude Code puts every tool call on the stream the bridge already reads, so the
hook was deleted rather than built and the narration is the bridge's.

## Consequences

The instruction that tells the agent it is in a spoken conversation is the
bridge's too, not part of aleph's identity, which keeps behavioural modes out
of aleph.
