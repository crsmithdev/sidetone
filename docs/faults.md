# Faults and recovery

Measured 20 October 2026 with claude 2.1.305, Sonnet and the live settings:
`silenceMs` 60 s, `ceilingMs` 600 s, `checkpointWindowMs` 15 s, `graceMs`
30 s. `scripts/fault-bench.ts` makes every number here. It runs the real
`Session` and the real `claude`, and sends a signal to the process. The
results stay in `~/.sidetone/faults/2026-10-20/` and
`~/.sidetone/faults/2026-10-20-b/` (the control and kill-tool).

## Result

| Question | Answer |
|---|---|
| Recovered | **6 of 6** faults: the supervisor restarted the process and the next turn answered |
| Actions done twice | **none**. A restart fails the turn that ran and does not send it again; marker.txt held one line |
| Time to recover from a dead or hung process | **60 s** to detect and 68 to 71 s to answer again, when no tool runs |
| A process that dies in a tool call | **642 s** to detect. The tool holds the silence timer (8.4.5), and nothing lets it go when the process dies, so only the ceiling ladder finds it: the checkpoint at 601 s, the interrupt, and the restart 30 s later. In use, the bridge asks a dead process for the agreement word |
| The session knew sooner | in every SIGKILL scenario the session saw the stream end at once ("the Claude Code process ended mid-turn"), but the restart waited for the silence timer |
| The conversation | **lost at every restart**. A restart starts a new process with no `--resume`, so the agent did not know the word. The control, with no fault, gave it back in 1.5 s |
| A hung process | **outlives its restart**. `stop()` sends SIGTERM, which a stopped process does not act on, so it stays until something kills it |
| A memory recycle | 0.3 s after the turn ends, and 5.7 s to answer again. It also loses the conversation |
| How sure | one run each. The detection times are set by the timers, so they repeat; the times to answer again vary with the agent |

## Every scenario

| scenario | fault | detected s | reason | back s | context kept | leftover process | actions |
|---|---|---|---|---|---|---|---|
| control | none | - | - | 1.5 | yes | - | - |
| kill-reply | SIGKILL while it writes | 60.1 | no activity on any channel | 70.6 | no | no | - |
| hang-reply | SIGSTOP while it writes | 60.4 | no activity on any channel | 69.4 | no | **yes** | - |
| kill-idle | SIGKILL between turns | 60.5 | no activity on any channel | 70.8 | no | no | - |
| kill-tool | SIGKILL in a tool call | 641.9 | the interrupt did not work | 651.1 | no | no | - |
| kill-after-action | SIGKILL after a Bash append | 60.1 | no activity on any channel | 67.5 | no | no | 1 |
| memory-recycle | limit set to 64 MB | 0.3 | process memory over the recycle limit | 5.7 | no | no | - |

Detected is from the signal to `onRestart`. Back is from the signal to the
end of the first turn that answered. For kill-idle, nothing notices a dead
process between turns: the next turn is what finds it.

## How it was run

| Step | What |
|---|---|
| Each scenario | a new session in a directory of its own; one turn teaches the word "marigold"; the fault; then a turn asks for the word |
| The faults | SIGKILL or SIGSTOP to the pid of `claude`, 1 s after the first word of a long reply, 2 s after a tool starts, after a tool ends, or between turns |
| The tool | `python3 -c 'import time; time.sleep(110)'` in the foreground. The voice instruction sends a longer command to the background, and Claude Code blocks a plain `sleep 120` |
| Not covered | a compaction loop, which a real process cannot be made to do (test/supervisor.test.ts covers it); a network drop between the phone and the bridge |
