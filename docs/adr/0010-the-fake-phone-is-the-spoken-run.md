# The fake phone is the spoken run; there is no desk loop

The bridge had two spoken loops: the room, over LiveKit, and a desk loop on
the machine's own microphone and speakers, which built 7.3 before the room
existed. The desk loop had no barge-in, because there is no echo cancellation
at the desk; it wrote no record, because its copy of the assembly had drifted;
and no test ran it. The fake phone (`scripts/fake-phone.ts`) drives the room
from a script with the same engines and the same messages a phone uses, so
it is the spoken run at the desk, and the desk loop is deleted (19 September
2026). The bridge is assembled once, in `src/bridge.ts`, and the room is its
one caller outside the tests.

## Considered options

- **Keep the desk loop as a second adapter.** One Speaker over paplay and one
  sound source over sox. It would test nothing the fake phone does not, and
  it would keep a listening policy of its own that the car never runs.
- **Delete it.** Chosen. A spoken check that needs no phone still exists; it
  goes through the room, so it exercises the code the car runs.

## Consequences

`bun src/main.ts voice` is gone, and so is `listenSettleMs`. A spoken check
at the desk is `bun scripts/fake-phone.ts "…"`, which needs the LiveKit
container. The text loop `chat` stays, because it is where the process
management is tested.
