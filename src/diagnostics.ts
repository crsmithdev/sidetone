/**
 * What the bridge has been doing lately, kept so it can be asked afterwards.
 *
 * The log already says most of this, but the log is on the machine and the
 * person who needs it is in a car. On 14 September a session came apart --
 * sentences arriving as fragments, the wake word missing three times -- and
 * the only record was a journal nobody could read at the time, with none of
 * the measurements that would have explained it.
 *
 * This holds the last of everything worth seeing, and `/diagnostics` hands it
 * over. It measures and remembers; it decides nothing.
 */
import type { Utterance } from "./audio.ts";

export interface Heard {
  kind: "heard";
  at: number;
  /** the recording, in milliseconds, pre-roll included */
  ms: number;
  /** how much of it was above the speech level */
  speechMs: number;
  peak: number;
  /** the quiet before it, which is the pause that ended the one before */
  gapMs: number;
  endedBy: "pause" | "flush";
  /** what the engine made of it, and how long that took */
  text: string;
  transcribeMs: number;
}

export interface Matched { kind: "matched"; at: number; said: string; became: string }
export interface Barged { kind: "barged"; at: number; level: number; heldMs: number }
export interface Spoke { kind: "spoke"; at: number; text: string; whole: boolean }
export interface Note { kind: "note"; at: number; text: string }
export type Event = Heard | Matched | Barged | Spoke | Note;

/** Enough to read a drive back, not so much that it is a log of its own. */
const KEEP = 120;

export class Diagnostics {
  private readonly events: Event[] = [];

  private add(event: Event): void {
    this.events.push(event);
    if (this.events.length > KEEP) this.events.shift();
  }

  heard(utterance: Utterance, text: string, transcribeMs: number, at = Date.now()): void {
    this.add({
      kind: "heard", at, text, transcribeMs,
      ms: utterance.ms, speechMs: utterance.speechMs, peak: utterance.peak,
      gapMs: utterance.gapMs, endedBy: utterance.endedBy,
    });
  }

  /** What the bridge made of it: a command, plain speech, or a wake word alone. */
  matched(said: string, became: string, at = Date.now()): void {
    this.add({ kind: "matched", at, said, became });
  }

  barged(level: number, heldMs: number, at = Date.now()): void {
    this.add({ kind: "barged", at, level: Number(level.toFixed(3)), heldMs: Math.round(heldMs) });
  }

  spoke(text: string, whole: boolean, at = Date.now()): void {
    this.add({ kind: "spoke", at, text, whole });
  }

  note(text: string, at = Date.now()): void {
    this.add({ kind: "note", at, text });
  }

  recent(limit = KEEP): Event[] {
    return this.events.slice(-limit);
  }

  /**
   * The shape of what was heard, which is the question a fragmented session
   * asks. Short utterances with a lot of quiet in them, arriving one pause
   * apart, are sentences being cut in half.
   */
  summary(): Record<string, unknown> {
    const heard = this.events.filter((e): e is Heard => e.kind === "heard");
    const barged = this.events.filter((e): e is Barged => e.kind === "barged");
    const ms = heard.map((h) => h.ms).sort((a, b) => a - b);
    const empty = heard.filter((h) => !h.text).length;
    return {
      utterances: heard.length,
      emptyTranscripts: empty,
      medianMs: middle(ms),
      shortestMs: ms[0] ?? 0,
      longestMs: ms[ms.length - 1] ?? 0,
      /** under a second and mostly quiet is the signature of a sentence cut short */
      shortAndQuiet: heard.filter((h) => h.ms < 1_500 && h.speechMs < h.ms * 0.6).length,
      medianPeak: middle(heard.map((h) => h.peak).sort((a, b) => a - b)),
      medianGapMs: middle(heard.map((h) => h.gapMs).sort((a, b) => a - b)),
      bargeIns: barged.length,
      medianBargeLevel: middle(barged.map((b) => b.level).sort((a, b) => a - b)),
    };
  }
}

function middle(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const at = Math.floor(sorted.length / 2);
  const value = sorted.length % 2 ? (sorted[at] as number) : ((sorted[at - 1] as number) + (sorted[at] as number)) / 2;
  return Number(value.toFixed(3));
}
