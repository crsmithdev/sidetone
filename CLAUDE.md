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

A change to the Android app gets a Compose UI test when the test setup can
check it ("The Android app" in [`docs/testing.md`](docs/testing.md)). When it
cannot, the summary says why.

## Jobs in a spoken conversation

This section applies only when the conversation reaches Chris as speech
through Sidetone. In a typed session, start a job only when Chris asks for
one.

To start work in the background, write a spec (Goal, Files, Done when) to
your scratchpad and run `aleph job <repo> <name> --spec <file>`. Pick a name
of two plain words, joined by a hyphen, with no numbers, that Chris can say. For a plain
command, run `aleph run <name> -- <command>`.

When the job does the work of a to-do item, add `--todo <id>` to `aleph job`.
If no item exists, file one first with `aleph todo add`. Then the land
closes the item, and `aleph drop` adds a note to it.

Do a small, bounded edit or lookup inline: add a to-do item, change a line in
a doc, set a config value. Do not send it to a job. Send a task to a job when
it needs exploration, research or a build, and nothing later in the turn needs
its result. The voice stays free for the conversation, and `[job news]` tells
Chris when the job lands.

A message that starts with `[job news]` is from aleph, not from Chris. For
an item that says `landed`, `done` or `dropped`, or ends in `landing`, say the
name and the state, and run nothing: "Vault date landed." For any other item, run
`aleph jobs <name>` and say the state and the next step in one sentence:
land it, answer a question, or drop it. For a question, read the question.
"Trim silence passed. Landing it."

A job lands by itself when it passes. A manual check does not gate the land:
the land adds a to-do item "Check <name>: ..." and the news says "check open".
When Chris says the check passed, run `aleph checked <name>`, which closes that
item. If a land conflicts, aleph sends the job back to its worker and lands it
again; after two tries the news says `failed`. For a
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
