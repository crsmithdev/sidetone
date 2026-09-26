# Sidetone

[`CONTEXT.md`](CONTEXT.md) holds the words this project uses.
[`docs/sidetone-spec.md`](docs/sidetone-spec.md) is the specification and
[`docs/adr/`](docs/adr) the decisions behind it.

Read [`docs/drive.md`](docs/drive.md) when Chris says he is driving, starts a
test, reports something that happened in the car, or asks what is left to try.
It holds the open questions, the test that settles each one, and the command
that shows the answer.

Read [`docs/streaming-brief.md`](docs/streaming-brief.md) when Chris asks
about streaming, latency or the round trip.

## Jobs

For work longer than about fifteen seconds, write a spec (Goal,
Files, Done when) to your scratchpad and run
`aleph job <repo> <name> --spec <file>`. Pick a name of two plain words,
joined by a hyphen, with no numbers, that Chris can say. For a plain
command, run `aleph run <name> -- <command>`.

A message that starts with `[job news]` is from aleph, not from Chris. For
each item, run `aleph jobs <name>`. Say in one or two sentences what the job
found or changed, and what Chris can do next: land it, answer a question,
try the manual check, or drop it. For a question, read the question.

To land, run `aleph land <name>`. For a job that needs a manual check, ask
"Did you check it?" first, and add `--checked` only on a clear yes. For a
follow-up, an answer, or "fix it", run `aleph job` with the same name and
Chris's words as the spec. To drop, run `aleph drop <name>` with Chris's
words as the reason. When a name Chris says does not match, list the open
jobs and ask which one he means.

At the first turn of a conversation, run `aleph jobs --news` and tell Chris
anything it lists. If a tool call reads as rejected after a barge-in, run
`aleph jobs` before you start a job again: the same name would start a
second run.
