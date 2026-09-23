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

## Long work

Run any task that takes more than about 15 seconds detached, never as a
subagent. A barge-in kills a subagent. Use:

```
scripts/job <name> env -u CLAUDECODE claude -p "<task>" --allowedTools "..."
```

The name is letters, digits and hyphens. The job writes to
`~/.sidetone/jobs/<id>/` and the bridge says "Job <name> finished." by voice.
Have the task write its result to a file, and read that file when the job ends.
For a plain command, use `scripts/job <name> <command>` or a background Bash.
