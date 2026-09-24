# The agent is permissive, behind a small gate

Driving by voice is worthless if every step asks permission, so the agent runs
permissive. A gated action happens only after Chris speaks the agreement word,
which is "continue" and deliberately not "yes": a specific word cannot come from
a reflex or a mis-transcription, and the gate fails closed. The bridge reads back
what it is about to do before it asks.

## Consequences

One action of the bridge is gated: clearing the context, which kills the process
the conversation lives in. Four actions of the agent are gated (spec 10.7): a
force push, a remote branch delete, `rm -rf` outside the project, and a drop or
truncate of a database. The agent asks the bridge before each of these, through
`--permission-prompt-tool stdio` and ask rules the bridge passes in `--settings`.

The ask rules are wider than the four: they send each `git push`, each `rm` and
each DROP or TRUNCATE to the bridge. The bridge allows each request that is not
one of the four. So auto mode does not judge these commands any more; the bridge
does. Before this change, an ask with no answer was a deny.

Everything else about what the agent may do comes from
the project's own instructions file, not from the bridge — the bridge does not
put the agent in a worktree, and the container that the specification asks for,
to isolate the file system and the processes, is not built.
