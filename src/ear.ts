/**
 * What the bridge does with sound, whatever carried it (spec 11.5, 18.4).
 *
 * The room and the desk differ in how audio arrives: the phone sends frames,
 * the desk hands over a whole recording. Everything after that is the same and
 * lives here — when a barge-in stops the speech, which utterances are too quiet
 * to have been a person, what the clock is told, and what a transcription that
 * comes back empty means.
 *
 * It was written twice before, once in each loop, in closures that no test
 * could enter: `serve.ts` and `main.ts` at 0b4478b.
 */
import { tooQuiet, Utterances, type Utterance, type UtteranceOptions } from "./audio.ts";
import type { CueName } from "./cues.ts";

/** What the ear tells. `Conversation` is the one that listens. */
export interface Ears {
  readonly isMuted: boolean;
  readonly latency: {
    spoke(endedAt: number, at: number): void;
    transcribed(): void;
    barged(level: number, heldMs: number): void;
  };
  cue(name: CueName): void;
  stopSpeaking(): void;
  heard(text: string): Promise<void>;
  heardNothing(): void;
}

/** What the ear writes down. `Diagnostics` is the one that keeps it. */
export interface EarNotes {
  barged(level: number, heldMs: number): void;
  heard(utterance: Utterance, text: string, transcribeMs: number): void;
  note(text: string): void;
}

export interface EarOptions extends UtteranceOptions {
  /** 4.6 under this, whisper is writing words for near-silence */
  minSpeechPeak: number;
  /** 11.5 the pause that ended the turn, which the clock has to give back */
  endOfTurnPauseMs: number;
}

export class Ear {
  private readonly utterances: Utterances;
  private barging = false;
  private noticedAt = 0;

  constructor(
    private readonly to: Ears,
    private readonly transcribe: (utterance: Utterance) => Promise<string>,
    private readonly options: EarOptions,
    private readonly notes?: EarNotes,
    private readonly say: (line: string) => void = console.log,
  ) {
    this.utterances = new Utterances(options);
  }

  /**
   * 9.5 muting is what makes the noise stop costing sentences. While muted the
   * bridge keeps transcribing, so "hey bridge, unmute" is still heard — it just
   * stops treating a lorry as a reason to shut up.
   */
  get bargingIn(): boolean {
    return this.utterances.bargingIn && !this.to.isMuted;
  }

  /** When the barge-in was noticed, for saying how late the speech stopped. */
  get bargedAt(): number {
    return this.noticedAt;
  }

  /** One frame from the room. Dispatches when the frame ends an utterance. */
  frame(frame: Int16Array): void {
    const said = this.utterances.push(frame);
    // 11.3 the moment Chris really starts, the bridge stops — every sentence,
    // not one. A recording opening is not enough: road noise opens recordings.
    if (this.bargingIn !== this.barging) {
      this.barging = this.bargingIn;
      if (this.barging) {
        this.noticedAt = Date.now();
        // 18.6 what caused it, so the two thresholds stop being a guess
        const { level, heldMs } = this.utterances.bargeIn;
        this.say(`  [barge-in: level ${level.toFixed(3)}, held ${Math.round(heldMs)}ms]`);
        this.to.latency.barged(level, heldMs);
        this.notes?.barged(level, heldMs);
        this.to.stopSpeaking();
      }
    }
    if (said) void this.said(said);
  }

  /**
   * The phone cut its microphone, so whatever was half recorded goes with it.
   *
   * The hold goes too. Without that, a cut in the middle of a barge-in leaves
   * no utterance to arrive, so nothing resolves the hold and the rest of the
   * answer sits behind it until the backstop drops it ten seconds later.
   */
  reset(): void {
    this.utterances.reset();
    this.barging = false;
    this.to.heardNothing();
  }

  /** One whole utterance, however it arrived. */
  async said(utterance: Utterance): Promise<void> {
    // 4.6 whisper writes words for near-silence even with its voice detector
    // on, and each invention costs a turn. Real speech is louder than this.
    if (tooQuiet(utterance, this.options.minSpeechPeak)) {
      this.notes?.heard(utterance, "", 0);
      this.say(`\n> (too quiet: peak ${utterance.peak.toFixed(2)}, under ${this.options.minSpeechPeak})`);
      this.to.heardNothing();
      return;
    }
    // 18.4 the clock starts on speech, and a lorry is not speech. The end of
    // the turn was the pause ago, not now: measuring from here would charge a
    // setting to the round trip.
    this.to.latency.spoke(Date.now() - this.options.endOfTurnPauseMs, Date.now());
    this.to.cue("heard");
    const readAt = Date.now();
    try {
      const text = await this.transcribe(utterance);
      this.to.latency.transcribed();
      const transcribeMs = Date.now() - readAt;
      this.notes?.heard(utterance, text, transcribeMs);
      this.say(this.shape(utterance, text, transcribeMs));
      // 11.3 road noise that carried no words must give the passage back
      if (!text) { this.to.heardNothing(); return; }
      await this.to.heard(text);
    } catch (error) {
      this.to.heardNothing();
      const message = `could not read that: ${(error as Error).message}`;
      this.notes?.note(message);
      this.say(`[${message}]`);
    }
  }

  /**
   * The shape of what was heard, which is what says whether a sentence was cut
   * in half: a short recording that is mostly quiet, arriving one end-of-turn
   * pause after the last one, is half a sentence.
   */
  private shape(utterance: Utterance, text: string, transcribeMs: number): string {
    return (
      `\n> ${text || "(nothing)"}` +
      `\n  [${(utterance.ms / 1000).toFixed(1)}s heard, ${(utterance.speechMs / 1000).toFixed(1)}s of speech in it, ` +
      `peak ${utterance.peak.toFixed(2)}, ${(utterance.gapMs / 1000).toFixed(1)}s quiet before, ` +
      `read in ${transcribeMs}ms]`
    );
  }
}
