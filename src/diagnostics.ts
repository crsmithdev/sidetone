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
/**
 * 18.4 a round trip that closed: the end of speech to the first sound of the
 * answer, and how the time between was spent. The last three are zero when
 * their mark was never made; a record from before 19 September lacks them.
 */
export interface Answered {
  kind: "answered"; at: number; answerMs: number; pauseMs: number; transcribeMs: number;
  agentMs: number; sentenceMs: number; synthesisMs: number;
}
export interface Barged { kind: "barged"; at: number; level: number; heldMs: number }
export interface Spoke { kind: "spoke"; at: number; text: string; whole: boolean }
export interface Note { kind: "note"; at: number; text: string }
/**
 * 9.4 a setting Chris changed out loud, mid-session. The header carries the
 * settings a session started with; this is the only witness to a change after
 * it, so a record read a week later can say which voice the second half ran in.
 */
export interface Setting { kind: "setting"; at: number; patch: Record<string, unknown> }
export type Event = Heard | Matched | Barged | Answered | Spoke | Note | Setting;

/** Enough to read a drive back, not so much that it is a log of its own. */
const KEEP = 120;

export class Diagnostics {
  private readonly events: Event[] = [];

  /**
   * `sink` is given every event as it happens, so the record on disk outlives
   * the process. Memory keeps the last KEEP; the sink keeps all of them.
   */
  constructor(private readonly sink?: (event: Event) => void) {}

  private add(event: Event): void {
    this.events.push(event);
    if (this.events.length > KEEP) this.events.shift();
    this.sink?.(event);
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

  /** 18.4 the round trip Chris lives with, kept with the utterance that caused it. */
  answered(round: Omit<Answered, "kind" | "at">, at = Date.now()): void {
    this.add({ kind: "answered", at, ...round });
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

  /** 9.4 a setting changed by voice, so the record explains what came after it. */
  setting(patch: Record<string, unknown>, at = Date.now()): void {
    this.add({ kind: "setting", at, patch });
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
