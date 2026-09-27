# Every voice decision lives in the bridge, not in the agent

The agent reads and writes text and knows nothing about audio. So Claude Code
needs no change to work by voice, and a voice decision can change without a
change to the agent. One piece looked like an exception: the narration that
fills the silence while a tool runs. The first spec put it in a hook inside
aleph, Chris's Claude Code plugin that holds the agent's identity, skills and
hooks. But Claude Code puts every tool call on the stream that the bridge
already reads. So we deleted the hook before we built it, and the bridge owns
the narration.

## Consequences

The instruction that tells the agent it is in a spoken conversation is the
bridge's too, not part of aleph's identity, which keeps behavioural modes out
of aleph.
