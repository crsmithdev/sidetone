# Sidetone

[`CONTEXT.md`](CONTEXT.md) holds the words this project uses.
[`docs/spec.md`](docs/spec.md) is the specification and
[`docs/adr/`](docs/adr) the decisions behind it.

Read "The drive card" in [`docs/testing.md`](docs/testing.md) when Chris says
he is driving, starts a test, reports something that happened in the car, or
asks what is left to try. It holds the open questions, the test that settles
each one, and the command that shows the answer.

Read "Latency" in [`docs/design.md`](docs/design.md) when Chris asks about
streaming, latency or the round trip.

## Jobs in a spoken conversation

This section applies only when the conversation reaches Chris as speech
through Sidetone. In a typed session, start a job only when Chris asks for
one.

To start work in the background, write a spec (Goal, Files, Done when) to
your scratchpad and run `aleph job <repo> <name> --spec <file>`. Pick a name
of two plain words, joined by a hyphen, with no numbers, that Chris can say. For a plain
command, run `aleph run <name> -- <command>`.

Send a task to a job, not inline, when it is small and independent. The
voice stays free for the conversation, and `[job news]` tells Chris when it
lands. A task is small when it is a bounded, mechanical edit or lookup: add
a to-do item, change a line in a doc, set a config value. A task is not
small when it needs exploration, a design decision on the way, or thought
before you can answer. A task is independent when nothing later in the turn
needs its result: you do not read the result back, and it does not decide
your next step. "Add a to-do item for the car cue" goes to a job. "What does
item 54 say?" stays inline: Chris waits for the answer.

A message that starts with `[job news]` is from aleph, not from Chris. For
an item that says `landed`, `done` or `dropped`, say the name and the state,
and run nothing: "Vault date landed." For any other item, run
`aleph jobs <name>` and say the state and the next step in one sentence:
land it, answer a question, try the manual check, or drop it. For a
question, read the question. "Trim silence passed. Land it, or try it in the
car first?"

To land, run `aleph land <name>`. For a job that needs a manual check, ask
"Did you check it?" first, and add `--checked` only on a clear yes. For a
follow-up, an answer, or "fix it", run `aleph job` with the same name and
Chris's words as the spec. To drop, run `aleph drop <name>` with Chris's
words as the reason. When a name Chris says does not match, list the open
jobs and ask which one he means.

Before each step of a check with several steps, say in one short sentence
what runs next. Chris hears nothing while a tool runs, so a silent chain of
steps sounds like a stall.

At the first turn of a conversation, run `aleph jobs --news` and tell Chris
anything it lists. If a tool call reads as rejected after a barge-in, run
`aleph jobs` before you start a job again: the same name would start a
second run.
