/**
 * What the bridge does with sound, whatever carried it (spec 11.5, 18.4).
 *
 * The phone sends frames; everything after that lives here — when a barge-in
 * stops the speech, which utterances are too quiet to have been a person,
 * what the clock is told, and what a transcription that comes back empty
 * means. `said` takes a whole utterance, which is what a test hands it.
 *
 * It was written twice before, once in each of two loops, in closures that no
 * test could enter: `serve.ts` and `main.ts` at 0b4478b.
 */
import { level, tooQuiet, Utterances, type Utterance, type UtteranceOptions } from "./audio.ts";
import type { CueName } from "./cues.ts";
import type { Measures } from "./measures.ts";

/** What the ear tells. `Conversation` is the one that listens. */
export interface Ears {
  readonly isMuted: boolean;
  cue(name: CueName): void;
  stopSpeaking(): void;
  /** `startedAt` is when the utterance began, in milliseconds since the epoch. */
  heard(text: string, startedAt?: number): Promise<void>;
  heardNothing(): void;
}

/**
 * What the ear reads. The detector's settings, under the names the config
 * gives them, plus the invention guard. A caller spreads the config over this
 * and adds the rate: there is no second copy of the names to keep in step.
 */
export interface EarOptions extends UtteranceOptions {
  /** 4.6 under this, whisper is writing words for near-silence */
  minSpeechPeak: number;
}

/** How long a dead microphone has to stay dead before the bridge says so. */
export const SILENCE_MS = 30_000;

/**
 * Below this a track is carrying no room at all.
 *
 * Not zero: a track of pure zeroes arrives through opus at a level of 1e-5,
 * and only 71 frames in 795 come out exactly zero (measured over a real room,
 * 18 September 2026). Road noise in a moving car reached 0.03 at its quietest
 * all through the drive, so this sits fifty times above a dead capture and far
 * below any microphone that is really open.
 */
export const SILENT_LEVEL = 0.0005;

export class Ear {
  private readonly utterances: Utterances;
  private barging = false;
  private noticedAt = 0;
  private frameAt = 0;
  private soundAt = 0;
  /**
   * 18.4 a transcription begun at the tentative end, and how much speech it
   * covered. It is the answer when the utterance finishes with the same
   * amount; otherwise Chris went on talking and it is thrown away.
   */
  private early: { speechMs: number; text: Promise<string | null> } | null = null;

  constructor(
    private readonly to: Ears,
    private readonly transcribe: (utterance: Utterance) => Promise<string>,
    private readonly options: EarOptions,
    private readonly measures: Measures,
    private readonly say: (line: string) => void = console.log,
  ) {
    // the detector reads the same object on every frame, so `set` reaches it
    this.utterances = new Utterances(options);
  }

  /**
   * Item 44 a threshold changed while the bridge runs. The detector and the
   * invention guard read their settings on every frame, so the next frame
   * uses the new value and nothing restarts. A key the ear does not read is
   * left alone.
   */
  set(patch: Partial<EarOptions>): void {
    Object.assign(this.options, Object.fromEntries(Object.entries(patch).filter(([key]) => key in this.options)));
  }

  /**
   * 9.5 muting is what makes the noise stop costing sentences. While muted the
   * bridge keeps transcribing, so "sidetone, unmute" is still heard — it just
   * stops treating a lorry as a reason to shut up.
   */
  get bargingIn(): boolean {
    return this.utterances.bargingIn && !this.to.isMuted;
  }

  /**
   * 18.13.3 how long since the microphone carried any sound at all, or null
   * before the first frame. A dead capture is quiet in a way no room is, and
   * the echo check needs to know: a microphone that carries nothing brings
   * nothing back, so the check reads as a pass.
   */
  get sinceSound(): number | null {
    return this.frameAt === 0 ? null : Date.now() - this.soundAt;
  }

  /** When the barge-in was noticed, for saying how late the speech stopped. */
  get bargedAt(): number {
    return this.noticedAt;
  }

  /**
   * How long the microphone has been dead, and in which of the two ways.
   *
   * A real microphone in a car is never silent: road noise alone reached the
   * recorder every few seconds all through the drive of 18 September. Frames
   * with nothing in them are a capture that stopped, and no frames at all are a
   * track that went away. Both looked the same from the outside -- nothing --
   * and the bridge said nothing about either for twenty minutes.
   */
  silence(now = Date.now()): { kind: "no frames" | "silence"; ms: number } | null {
    if (this.frameAt === 0) return null;
    if (now - this.frameAt >= SILENCE_MS) return { kind: "no frames", ms: now - this.frameAt };
    if (now - this.soundAt >= SILENCE_MS) return { kind: "silence", ms: now - this.soundAt };
    return null;
  }

  /** 9.5.2 whether the hold to talk button is down, which keeps the utterance open through a pause. */
  hold(on: boolean): void {
    this.utterances.held = on;
  }

  /** One frame from the room. Dispatches when the frame ends an utterance. */
  frame(frame: Int16Array, now = Date.now()): void {
    // the first frame starts both clocks: a capture that was dead from the
    // start is worth saying once, not the instant it arrives
    const silent = this.frameAt > 0 && level(frame) < SILENT_LEVEL;
    this.frameAt = now;
    if (!silent) this.soundAt = now;
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
        this.measures.bargeIn(level, heldMs);
        this.to.stopSpeaking();
      }
    }
    // 18.4 the engine starts on the guess, so the text is usually in hand
    // when the pause runs out. Too quiet is dropped either way, so it is not
    // worth a transcription now either.
    const tentative = this.utterances.tentativeEnd();
    if (tentative && !tooQuiet(tentative, this.options.minSpeechPeak)) {
      this.early = { speechMs: tentative.speechMs, text: this.transcribe(tentative).catch(() => null) };
    }
    if (said) void this.said(said);
  }

  /**
   * The phone cut its microphone, so whatever was half recorded goes with it.
   *
   * The hold goes too. Without that, a cut in the middle of a barge-in leaves
   * no utterance to arrive, so nothing resolves the hold and the rest of the
   * answer sits behind it until the backstop drops it ten seconds later.
   *
   * 9.5.2 `release` is a hold to talk button let go. What was recorded is an
   * utterance that ends now, without the end-of-turn pause. When nothing was
   * recorded, it is a plain cut.
   */
  reset(release = false): void {
    const said = release ? this.utterances.flush() : null;
    this.utterances.reset();
    this.barging = false;
    this.frameAt = 0;
    this.soundAt = 0;
    if (said) {
      // `said` takes the guess made at the tentative end, and clears it
      void this.said(said);
      return;
    }
    this.early = null;
    this.to.heardNothing();
  }

  /** One whole utterance, however it arrived. */
  async said(utterance: Utterance): Promise<void> {
    // it ended now, so it began its length ago
    const startedAt = Date.now() - utterance.ms;
    const early = this.early;
    this.early = null;
    // 4.6 whisper writes words for near-silence even with its voice detector
    // on, and each invention costs a turn. Real speech is louder than this.
    if (tooQuiet(utterance, this.options.minSpeechPeak)) {
      this.measures.utterance(utterance, "", 0);
      this.say(`\n> (too quiet: peak ${utterance.peak.toFixed(2)}, under ${this.options.minSpeechPeak})`);
      this.to.heardNothing();
      return;
    }
    // 18.4 the clock starts on speech, and a lorry is not speech. The end of
    // the turn was the pause ago, not now: measuring from here would charge a
    // setting to the round trip.
    this.measures.speechEnded(Date.now() - this.options.endOfTurnPauseMs, Date.now());
    this.to.cue("heard");
    const readAt = Date.now();
    try {
      // the guess was right when nothing was said after it: the text is on its way already
      const guessed = early && early.speechMs === utterance.speechMs ? await early.text : null;
      const text = guessed ?? await this.transcribe(utterance);
      this.measures.transcribed();
      const transcribeMs = Date.now() - readAt;
      this.measures.utterance(utterance, text, transcribeMs);
      this.say(this.shape(utterance, text, transcribeMs, guessed !== null));
      // 11.3 road noise that carried no words must give the passage back
      if (!text) { this.to.heardNothing(); return; }
      await this.to.heard(text, startedAt);
    } catch (error) {
      this.to.heardNothing();
      const message = `could not read that: ${(error as Error).message}`;
      this.measures.note(message);
      this.say(`[${message}]`);
    }
  }

  /**
   * The shape of what was heard, which is what says whether a sentence was cut
   * in half: a short recording that is mostly quiet, arriving one end-of-turn
   * pause after the last one, is half a sentence.
   */
  private shape(utterance: Utterance, text: string, transcribeMs: number, early: boolean): string {
    return (
      `\n> ${text || "(nothing)"}` +
      `\n  [${(utterance.ms / 1000).toFixed(1)}s heard, ${(utterance.speechMs / 1000).toFixed(1)}s of speech in it, ` +
      `peak ${utterance.peak.toFixed(2)}, ${(utterance.gapMs / 1000).toFixed(1)}s quiet before, ` +
      `read in ${transcribeMs}ms${early ? ", begun at the tentative end" : ""}` +
      `${utterance.falseEnds ? `, ${utterance.falseEnds} false end${utterance.falseEnds > 1 ? "s" : ""}` : ""}]`
    );
  }
}
