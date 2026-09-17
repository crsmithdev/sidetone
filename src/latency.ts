/**
 * How long the round trip really takes (spec 18.4).
 *
 * The car test said the latency felt good. Felt is not measured, and the one
 * number that matters is the one the person on the phone lives with: from the
 * moment Chris stops talking to the moment the first sound of the answer
 * leaves the bridge. Everything between is the bridge's own doing.
 *
 * The clock starts at the real end of speech, not at the moment the bridge
 * notices it. The bridge only notices after the end-of-turn pause, so that
 * pause is subtracted by the caller — otherwise every measurement carries a
 * setting as if it were a cost.
 */

export interface Round {
  /**
   * 11.5 the end-of-turn pause, which is a setting and not a cost. The bridge
   * cannot know a turn ended until the pause has run, so this sits in every
   * round trip and belongs on its own line rather than inside the engine's.
   */
  pauseMs: number;
  /** the engine's share: the recording becomes text */
  transcribeMs: number;
  /** the whole of it: the end of speech to the first audio out */
  answerMs: number;
}

/** Enough rounds to have a median, few enough that a drive ago does not count. */
const KEEP = 20;

/** What a barge-in turned out to be, once the utterance behind it was read. */
export type Outcome = "speech" | "command" | "nothing";

export class Latency {
  private open: { endedAt: number; noticedAt: number; transcribedAt: number } | null = null;
  private readonly rounds: Round[] = [];
  /**
   * 18.6 every barge-in, with the sound that caused it. The two thresholds are
   * a guess until a drive says otherwise, and a barge-in that turned out to be
   * nothing is the one that cost a sentence for no reason.
   */
  private readonly bargeIns: Array<{ level: number; heldMs: number; as: Outcome | null }> = [];

  /**
   * Chris stopped talking. `endedAt` is when he stopped and `noticedAt` is when
   * the bridge could tell, which is one end-of-turn pause later. Both are
   * needed: the total has to run from when he stopped, and the engine's share
   * must not be charged for a wait that a setting decides.
   */
  speechEnded(endedAt: number, noticedAt = Date.now()): void {
    this.open = { endedAt, noticedAt, transcribedAt: 0 };
  }

  /** The recording is text. */
  transcribed(at = Date.now()): void {
    if (this.open && !this.open.transcribedAt) this.open.transcribedAt = at;
  }

  /**
   * The first audio of the answer is on its way. Later sentences are not a
   * round. Returns the round it closed, or null when it closed none: a caller
   * that records rounds must not record the one before this again.
   */
  answered(at = Date.now()): Round | null {
    const open = this.open;
    if (!open) return null;
    this.open = null;
    const round: Round = {
      pauseMs: open.noticedAt - open.endedAt,
      transcribeMs: open.transcribedAt ? open.transcribedAt - open.noticedAt : 0,
      answerMs: at - open.endedAt,
    };
    this.rounds.push(round);
    if (this.rounds.length > KEEP) this.rounds.shift();
    return round;
  }

  /** 11.3 the playback stopped. `level` is the loudest frame that did it. */
  barged(level: number, heldMs: number): void {
    this.bargeIns.push({ level, heldMs, as: null });
    if (this.bargeIns.length > KEEP) this.bargeIns.shift();
  }

  /** What the utterance behind the last barge-in turned out to be. */
  resolved(as: Outcome): void {
    const last = this.bargeIns[this.bargeIns.length - 1];
    if (last && last.as === null) last.as = as;
  }

  get bargeInCount(): number { return this.bargeIns.length; }

  /** The ones that cost a sentence and carried nothing. */
  get falseBargeIns(): number {
    return this.bargeIns.filter((one) => one.as === "nothing").length;
  }

  get count(): number { return this.rounds.length; }

  get last(): Round | null { return this.rounds[this.rounds.length - 1] ?? null; }

  /** The middle of the recent rounds, which a mean would hide behind one bad tunnel. */
  median(): number {
    if (this.rounds.length === 0) return 0;
    const sorted = this.rounds.map((round) => round.answerMs).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? (sorted[middle] as number) : (((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
  }

  worst(): number {
    return this.rounds.reduce((worst, round) => Math.max(worst, round.answerMs), 0);
  }

  /** 9.4 spoken, so it has to be sentences a person can hear once and keep. */
  report(): string {
    const last = this.last;
    if (!last) return "No round trip has been measured yet.";
    // One sentence of all of this ran fourteen seconds on a real run, which is
    // a long time to be talked at in a car. Short sentences, and the ones a
    // person is least likely to want come last.
    const parts = [`Last answer, ${seconds(last.answerMs)} seconds.`];
    if (this.rounds.length > 1) parts.push(`Median ${seconds(this.median())}, worst ${seconds(this.worst())}.`);
    parts.push(`${seconds(last.pauseMs)} of it was the end of turn pause.`);
    if (this.bargeIns.length > 0) {
      parts.push(`${this.bargeIns.length} barge-ins, ${this.falseBargeIns} of them nothing.`);
    }
    return parts.join(" ");
  }
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}
