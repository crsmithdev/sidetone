/**
 * Everything the bridge knows about how a turn went, told once (spec 18).
 *
 * There were two bookkeepers. `Latency` held the round trip for the spoken
 * report; `Diagnostics` held the events for the record and `/diagnostics`. Both
 * were told the same facts from the same places — a barge-in twice, a round
 * twice, an utterance twice — and nothing checked that they agreed.
 *
 * They are still the two things inside; they are no longer two things to tell.
 * The ordering that matters lives here: speech ends, then it is text, then the
 * answer starts. A fact out of order is dropped rather than half recorded.
 */
import type { Utterance } from "./audio.ts";
import { Diagnostics, type Device, type Event } from "./diagnostics.ts";
import { Latency, type Outcome, type Round } from "./latency.ts";
import type { AudioSetup } from "./messages.ts";

export class Measures {
  private readonly latency = new Latency();
  private readonly diagnostics: Diagnostics;

  /** `sink` gets every event as it happens, so the record outlives the process. */
  constructor(sink?: (event: Event) => void) {
    this.diagnostics = new Diagnostics(sink);
  }

  /**
   * Chris stopped talking, at `endedAt`; the bridge could only tell one
   * end-of-turn pause later, which is `noticedAt`. The pause is a setting, not
   * a cost, and the two times are what keeps it out of the engine's share.
   */
  speechEnded(endedAt: number, noticedAt = Date.now()): void {
    this.latency.speechEnded(endedAt, noticedAt);
  }

  /** The recording is text. */
  transcribed(at = Date.now()): void {
    this.latency.transcribed(at);
  }

  /** The agent's first word of the answer. */
  firstDelta(at = Date.now()): void {
    this.latency.firstDelta(at);
  }

  /** The first whole sentence of the answer reached the mouth. */
  firstSentence(at = Date.now()): void {
    this.latency.firstSentence(at);
  }

  /** What the engine spent making the sentence about to close the round. */
  synthesized(ms: number): void {
    this.latency.synthesized(ms);
  }

  /** What that utterance was, and what the engine made of it. */
  utterance(utterance: Utterance, text: string, transcribeMs: number): void {
    this.diagnostics.heard(utterance, text, transcribeMs);
  }

  /** 11.3 the playback stopped, and the sound that stopped it. */
  bargeIn(level: number, heldMs: number): void {
    this.latency.barged(level, heldMs);
    this.diagnostics.barged(level, heldMs);
  }

  /**
   * 11.9 Chris spoke over a turn that runs. Item 4 what he said went into the
   * turn, or, with the result already back, waited `waitedMs` for the turn to
   * end and became the next one. The bridge no longer interrupts.
   */
  cutOff(waitedMs: number, interrupted: boolean, injected: boolean): void {
    this.diagnostics.cutoff(waitedMs, interrupted, injected);
  }

  /** 18.6 what the utterance behind that barge-in turned out to be. */
  bargeInWas(outcome: Outcome): void {
    this.latency.resolved(outcome);
  }

  /**
   * 18.4 the first audio of the answer is on its way, which closes the round.
   * A later sentence of the same answer closes nothing, and records nothing.
   */
  answering(at = Date.now()): Round | null {
    const round = this.latency.answered(at);
    if (round) this.diagnostics.answered(round, at);
    return round;
  }

  /** A sentence reached Chris, whole or cut short by a barge-in. */
  spoken(text: string, whole: boolean): void {
    this.diagnostics.spoke(text, whole);
  }

  /** 9.4 what the bridge decided a thing Chris said actually was. */
  matched(said: string, became: string): void {
    this.diagnostics.matched(said, became);
  }

  note(text: string): void {
    this.diagnostics.note(text);
  }

  /** 9.4 a setting Chris changed out loud, kept beside what it changed. */
  setting(patch: Record<string, unknown>): void {
    this.diagnostics.setting(patch);
  }

  /**
   * 18.10 the bridge heard its own voice. It is recorded and not acted on: a
   * person may read a sentence back, and the cost of being wrong about that is
   * higher than the cost of a line in the record.
   */
  echo(said: string, spoke: string): void {
    this.diagnostics.echo(said, spoke);
  }

  /** 14.15 what the phone said about itself as it joined. */
  device(event: Device): void {
    this.diagnostics.device(event);
  }

  /** 18.15 the bridge pushed the phone an audio setup, or null for the one in its code. */
  setup(pushed: AudioSetup | null): void {
    this.diagnostics.setup(pushed);
  }

  /** 15.7 a track began on the room's speaker: the hold music, or a file asked for. */
  trackStarted(what: "music" | "file"): void {
    this.diagnostics.trackStarted(what);
  }

  /** 15.7 and it ended, after `ms`, whole or cut short. */
  trackStopped(what: "music" | "file", ms: number, whole: boolean): void {
    this.diagnostics.trackStopped(what, ms, whole);
  }

  /** 9.4 the stats command, spoken, so it has to be heard once and kept. */
  report(): string {
    return this.latency.report();
  }

  /** What `/diagnostics` hands over, and what a drive is read back from. */
  summary(): Record<string, unknown> {
    return this.diagnostics.summary();
  }

  recent(limit?: number): Event[] {
    return this.diagnostics.recent(limit);
  }

  rounds(): { rounds: number; medianMs: number; worstMs: number } {
    return { rounds: this.latency.count, medianMs: this.latency.median(), worstMs: this.latency.worst() };
  }
}
