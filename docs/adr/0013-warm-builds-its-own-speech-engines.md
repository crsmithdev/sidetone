# Warm builds its own speech engines

`bun src/main.ts warm` (`warm` in `src/main.ts`) and `assemble` in
`src/bridge.ts` each build the speech-to-text engine, the text-to-speech engine
and a `SpokenAhead` over the kept lines. An architecture review on 26 September
2026 proposed one builder for both. We keep two (27 September 2026), because the
differences are the point of each:

| | `warm` | `assemble` |
|---|---|---|
| Start | one engine at a time, because the GPU is shared with a bridge that may be running | all together, with the cues |
| Kept lines | `cut: clipCutter(stt)`: a line no take says cleanly alone is cut out of its carrier (11.6.3, item 33) | checked only; `SpokenAhead.carry` runs only from `warm` |
| Sent clips | none | a copy of each clip sent (18.14) |
| Cues | none | built |

## Considered options

- **One builder with options.** It would need one option for each row above and
  would share four lines. It adds parts and hides nothing.
- **Two builders.** Chosen. Each reads as what it is for.

## Consequences

A change to how an engine is made (a new worker argument, a new engine) is made
in both places. Do not propose the merge again unless the rows above stop
differing.
