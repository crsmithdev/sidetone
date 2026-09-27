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

The ask rules (`ASK_RULES` in `src/gated.ts`, spec 10.8) are wider than the
four. They send the bridge each `git push`, `rm`, `dropdb`, `bash`, `sh`,
`eval`, `xargs` and `find`, and each command that holds DROP or TRUNCATE in
upper, title or lower case. The bridge allows each request that is not one of the four. So auto mode
(the Claude Code permission mode that decides each tool call without a prompt)
does not judge these commands any more; the bridge does. Before the gate landed
on 24 September 2026 (to-do item 35), nothing answered an ask, and an ask with no
answer was a deny.

Everything else about what the agent may do comes from the project's own
instructions file, not from the bridge. The bridge does not put the agent in a
worktree. The specification asks for a container that isolates the file system
and the processes, and nobody has built it.
