# Observability brief

This is the plan for item 21 in [`todo.md`](todo.md), the web dashboard.
Delete this file when item 21 lands.

Written 23 September 2026 and updated 27 September. This brief lists what the
bridge and the app expose for debugging, what is missing, and the order to
build it. The dashboard of item 21 shows this data. Chris agreed the order.

## What exists

These sources exist now. The dashboard reads them.

| Source | What it holds |
|---|---|
| `~/.sidetone/record.jsonl` | one line for each event, with its timing: for example `heard`, `answered`, `spoke`, `barged`, `cutoff`, `session`, `setting`, `device`, `turnGuess` |
| the journal of `sidetone.service` | events, false ends, screen log and screenshot notices |
| `~/.sidetone/screen/` | what the app showed, one file for each conversation |
| `~/.sidetone/screenshots/` | screenshots that the phone sent |
| `/diagnostics` | a live summary, recent events, the settings in force, and the network quality level of the phone and of the bridge |
| `device` lines in the record | the phone model, the echo canceller and the audio route, on each join |
| `~/.sidetone/crashes/` | the crash reports that the app sent, one file for each crash |
| Langfuse, port 3010 | the trace of each agent turn, with model, token and cost data |

Langfuse keeps the traces of the agent and the model. The dashboard does not
copy them. It links to them.

## Build first

These three items come first, because the turn view needs them.

1. **One turn id.** One id appears in the journal, the record, the screen log,
   the screenshots and the Langfuse trace. Without it, the turn view cannot
   join them with certainty.
2. **The playout report.** The round trip now ends when the bridge sends the
   audio. The real delay ends when the phone plays it. The app reports the time
   that each sentence starts to play, and the bridge compares it with its own
   clock. This needs a clock offset between the two, measured on each join.
3. **Cost in the record.** `Turn.costUsd` exists but the record does not
   keep it. Add it to each `answered` event. The `answered` line already has
   the input and cache token counts of the first request.

## Build next

4. **Network health from both ends.** `/diagnostics` has the quality level
   only. Add the LiveKit statistics: packet loss, jitter and round-trip time,
   from the bridge and from the app.
5. **The audio state of the phone.** The `device` line has the audio route.
   Add the audio mode and the focus holder. This explains the car results
   that the bridge cannot see (drive test 6).
6. **The reason for each cut.** Each time the voice is cut, the record says why:
   the level that the bridge saw and the rule that fired.
7. **Crash reports in the turn view.** The reports exist in
   `~/.sidetone/crashes/`. The turn view shows a crash next to the turn that
   was active.

## Build later

8. **The recognizer.** Store the confidence of each utterance. Keep the input
   audio of the last few utterances so that a misheard word can be played back.
   Item 33 does the same for the voice: `~/.sidetone/sent/` keeps each clip
   that the bridge sent, and `bun scripts/sent-check.ts` transcribes it.
9. **Bridge health.** Memory, GPU memory, restarts and recycles, and the depth
   of the queues. See the vault note "Torch mem_get_info Does Not See Other Processes Under
   WSL" for the command.
10. **The timeline.** Hold music, jobs and settings changes on the same
    timeline as the turns.

## The views

- The turn view comes first. It shows one turn from start to end: what Chris
  said, the transcript, the timeline of the pause, the agent, the first
  sentence and the voice, the events, the screen log and a link to the trace.
- The aggregate view comes after Chris has used the turn view. It shows the
  timings over time and the outliers. Each point opens its turn.
- The dashboard reads the existing files. It adds no store.

## How to build the page

- Use a component framework and a CSS framework. Do not write the page as
  hand-made HTML with one large stylesheet. The build picks both and says why,
  with the Bun and TypeScript stack of this repo in mind.
- Before the build, make several mock-ups of the turn view, as options for
  Chris to choose from. Build the chosen option only.
- Use the `impeccable` skill for the design and the mock-ups. Add the skills
  that fit: `dataviz` for every chart, `make-interfaces-feel-better` for the
  details, and `frontend-design` for the direction.

## Unknown

- How far the clocks of the phone and the bridge drift within one session. The
  playout report needs this to be small.
- Whether the LiveKit statistics of the app are available through the SDK that
  the app uses. Check before item 4.
