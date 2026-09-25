/**
 * The turn detector in shadow (spec 18.16).
 *
 * At each tentative end the ear asks a small model whether the turn sounds
 * complete, and this writes down what it said beside what then happened.
 * Nothing waits for it. The pause still ends every utterance, so a slow, dead
 * or wrong detector changes nothing Chris hears. The record is what decides
 * whether the detector may ever end a turn early.
 */
import type { Utterance } from "./audio.ts";
import type { TurnGuess } from "./diagnostics.ts";

/** What the model says about one stretch of audio. */
export interface TurnScore {
  /** the chance that the turn is complete, 0 to 1 */
  probability: number;
  /** the worker's own time: the downsampling, the features and the model */
  inferenceMs: number;
}

/** How much of the end of the utterance the model reads. */
const TURN_SECONDS = 8;

/**
 * How long a line waits, after its outcome is known, for the model and the
 * early transcription. A worker that has not answered by then never will in
 * time to matter, and the line goes without it.
 */
const GUESS_WAIT_MS = 3_000;

/** A promise's value, or null when it fails or takes longer than `ms`. */
function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      () => { clearTimeout(timer); resolve(null); },
    );
  });
}

interface Open {
  at: number;
  quietMs: number;
  score: Promise<TurnScore | null>;
  text: Promise<string | null>;
}

type Outcome = Pick<TurnGuess, "outcome" | "resumedAfterMs" | "endedBy">;

/**
 * One guess at a time: the one made at the latest tentative end. Speech that
 * comes back, the end of the utterance, or a cut closes it, and the line is
 * written once the model and the early transcription have answered or the
 * wait has run out.
 */
export class TurnGuesses {
  /**
   * The worker, once it has loaded, given the last eight seconds at the
   * room's rate: it downsamples them itself. Null writes nothing: the detector is off.
   */
  score: ((pcm: Int16Array, rate: number) => Promise<TurnScore>) | null = null;
  private open: Open | null = null;
  /** a request the worker has not answered: a second one would queue behind it */
  private busy = false;

  constructor(
    private readonly sampleRate: number,
    private readonly write: (line: TurnGuess) => void,
    private readonly waitMs = GUESS_WAIT_MS,
  ) {}

  /** A tentative end: ask the model, and never wait for it. `text` is the early transcription. */
  tentative(utterance: Utterance, text: Promise<string | null>, at = Date.now()): void {
    const score = this.score;
    if (!score) return;
    this.open = { at, quietMs: utterance.quietMs, score: this.ask(score, utterance.samples), text };
  }

  private ask(score: (pcm: Int16Array, rate: number) => Promise<TurnScore>, samples: Int16Array): Promise<TurnScore | null> {
    if (this.busy) return Promise.resolve(null);
    this.busy = true;
    // the copy and the encoding run after the frame, not in it
    const asked = new Promise<TurnScore>((resolve, reject) => {
      setTimeout(() => {
        try { score(samples.slice(-this.sampleRate * TURN_SECONDS), this.sampleRate).then(resolve, reject); } catch (error) { reject(error); }
      }, 0);
    });
    asked.then(() => { this.busy = false; }, () => { this.busy = false; });
    return asked;
  }

  /** Speech came back after `afterMs` of quiet: the turn was not over. */
  resumed(afterMs: number): void {
    this.close({ outcome: "resumed", resumedAfterMs: afterMs });
  }

  /** The utterance ended on this pause, or on a release. */
  ended(endedBy: "pause" | "flush"): void {
    this.close({ outcome: "ended", endedBy });
  }

  /** The microphone was cut and the recording dropped. */
  cut(): void {
    this.close({ outcome: "cut" });
  }

  private close(outcome: Outcome): void {
    const open = this.open;
    if (!open) return;
    this.open = null;
    void Promise.all([within(open.score, this.waitMs), within(open.text, this.waitMs)]).then(([score, text]) => {
      this.write({
        kind: "turnGuess", at: open.at,
        probability: score?.probability ?? null, inferenceMs: score?.inferenceMs ?? null,
        quietMs: open.quietMs, ...outcome, text,
      });
    });
  }
}
