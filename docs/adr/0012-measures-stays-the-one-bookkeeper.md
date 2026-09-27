# Measures stays the one bookkeeper

`Measures` (`src/measures.ts`) is told each fact about a turn once, and it
passes the fact on to `Latency` (the round trip for the spoken report) and
`Diagnostics` (the events for the record and `/diagnostics`). Most of its
methods only pass a call on, so an architecture review on 26 September 2026
proposed to delete it: the callers would write typed events to the record,
and the round trip would be read back from those events, as the scorecard
reads a drive. We keep `Measures` (27 September 2026).

## Considered options

- **Delete `Measures`; the callers write to `Latency` and `Diagnostics`.**
  About 30 call sites in five files would then choose between two objects.
  A barge-in and the start of an answer go to both, and the two used to be
  told twice from two places with nothing to check that they agreed. That
  defect comes back.
- **Derive the round trip from the record's events.** This removes the second
  bookkeeper, but it changes how the spoken report adds up a round, and no
  bug asks for that.
- **Keep `Measures` as the one place a fact is told.** Chosen. It is shallow,
  but it is the seam that makes "told once" true.

## Consequences

A new fact still costs an event type in `diagnostics.ts`, a method in
`measures.ts` and a call site. Do not propose this deletion again unless the
spoken report is to be computed from the record. The order rule lives in
`src/latency.ts`: a fact with no open round is dropped, and the first write
wins.
