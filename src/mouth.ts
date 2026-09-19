/**
 * What the bridge says, from a sentence to the sound of it (spec 5.7, 11.3,
 * 11.6, 11.10).
 *
 * Two queues. `outbox` is the answer, sentence by sentence. `ahead` is the
 * bridge's own replies, and it jumps a hold: a reply to a command has to be
 * heard *now*, over a held answer, because you asked for it in the middle of
 * the answer on purpose. A barge-in holds `outbox` and never `ahead`.
 *
 * The room and the desk used to each write the part between the queue and the
 * transport -- make the sentence, mark the round trip, start the next one,
 * play -- and neither copy had a test. It is one place now, and the two loops
 * supply only the part where they differ: a `Speaker`, which plays one wav.
 */
import type { Config } from "./config.ts";
import type { CueName, Cues } from "./cues.ts";
import type { Measures } from "./measures.ts";
import { voiceSignature, type SpokenAhead } from "./speech.ts";

/**
 * The sentences the bridge says in its own voice, word for word, over and
 * over: an acknowledgement, a refusal, a thing it has nothing to say about.
 *
 * They are worth keeping because of what they cost. The cloning voice spends
 * about two and a half seconds on a sentence, and these are the sentences that
 * jump the queue precisely because they are answers to a command and should
 * land at once. Made once and kept on disk, they land at once.
 *
 * `test/conversation.test.ts` says every command from a fresh start and checks
 * that each fixed line it answers with is here: until 19 September the list was
 * kept by hand and five lines had drifted out of it. A line that is missing is
 * made the slow way and then kept, so the drift costs one slow sentence, once,
 * and never a wrong one. Anything with a number or a name in it belongs
 * nowhere near this list.
 */
export const KEPT_LINES = [
  "Muted.",
  "Listening.",
  "Tones on.",
  "Tones off.",
  "Interrupting on.",
  "Interrupting off.",
  "Carrying on.",
  "Stopped.",
  "Nothing is running.",
  "Context cleared.",
  "No round trip has been measured yet.",
  "Nothing has reported on the connection yet.",
  "Nothing was cleared.",
  "That turn did not finish.",
  "There is nothing to restate yet.",
  "There is nothing to summarize yet.",
  "There is nothing left of it.",
  "We have not started yet.",
  "This engine has only the one voice.",
  "Switched to the female voice.",
  "Switched to the male voice.",
] as const;

/**
 * What a run keeps between runs, and under which key. The signature is the
 * engine's own: every setting that changes how its voice sounds, so a sentence
 * made at one setting is never played back at another.
 */
export function keptLines(config: Config): { dir: string; signature: string; lines: readonly string[] } {
  return { dir: config.spokenDir, signature: voiceSignature(config), lines: KEPT_LINES };
}

/** The part that plays one sound. The room and a test differ only here. */
export interface Speaker {
  /**
   * Play one sentence, made. False means a barge-in cut it short (11.3):
   * `cut` says whether Chris is talking, and a speaker that can stop between
   * frames asks it as it goes.
   *
   * `wav` is null when the voice is off (11.12): nothing is played, and the
   * words still go wherever the spoken ones are written down.
   */
  play(text: string, wav: string | null, cut: () => boolean): Promise<boolean>;
  /** 15.2 a tone. The mouth has checked that nothing is speaking. */
  cue(wav: string, cut: () => boolean): void;
}

export class Mouth {
  private readonly outbox: string[] = [];
  private readonly ahead: string[] = [];
  private pumping = false;
  private playing = false;
  private waiters: Array<() => void> = [];
  /** 11.3 true from the barge-in until what Chris said is resolved. */
  private holding = false;
  private holdBackstop: ReturnType<typeof setTimeout> | null = null;
  /**
   * What a discard took off the queue, so "carry on" can say it and the
   * client can show it. Chris never heard these, and the agent's own context
   * holds them as though he did.
   */
  private tail: string[] = [];
  /** What has actually reached Chris's ears this turn, for 9.4.5. */
  private heard: string[] = [];
  /** 11.12 whether the bridge speaks at all. The words go either way. */
  private voice = true;
  /** 18.4 whether the next sentence of the answer is the turn's first. */
  private firstOfTurn = true;

  constructor(
    private readonly speaker: Speaker,
    /** 11.6 the sentence made ahead of time, the kept ones, and whose voice */
    private readonly made: Pick<SpokenAhead, "take" | "start" | "use">,
    private readonly cues: Pick<Cues, "file">,
    /** 18.4 the round trip closes here, so the one bookkeeper lives here. */
    readonly measures: Measures,
    /**
     * `talking` is the ear's word on whether Chris is speaking right now. It
     * is not the hold: a reply to a command plays over a hold on purpose, and
     * the gate's question waits seconds with the hold up. It is what stops
     * the frames, and it is wired once, by whoever assembles the bridge.
     */
    private readonly settings: { holdBackstopMs: number; voiceChoices: Config["voiceChoices"]; talking?: () => boolean },
  ) {
    this.talking = settings.talking ?? (() => false);
  }

  private readonly talking: () => boolean;

  /** One sentence of the answer. It is what a barge-in holds. */
  say(text: string): void {
    // 18.4 the collector's share ends here, whatever the queue does next
    if (this.firstOfTurn) { this.firstOfTurn = false; this.measures.firstSentence(); }
    this.outbox.push(text);
    void this.pump();
  }

  /** One sentence from the bridge itself. It jumps a hold, because you asked now. */
  reply(text: string): void {
    this.ahead.push(text);
    void this.pump();
  }

  /** Whether a sentence is playing. A cue never goes over one. */
  get speaking(): boolean { return this.playing; }
  /** 11.3 whether an answer is waiting to find out what Chris just said. */
  get onHold(): boolean { return this.holding; }
  /** The sentences Chris heard this turn, whole, in order. */
  get said(): readonly string[] { return this.heard; }

  /** A turn begins: what he heard of the last one is the last one's. */
  newTurn(): void {
    this.heard = [];
    this.firstOfTurn = true;
  }

  /** 11.12 the voice off skips the engine; the round trip still closes. */
  setVoice(on: boolean): void {
    this.voice = on;
  }

  /**
   * 4.9 the two voices Chris switches between out loud. The voice is a
   * setting, so changing it changes nothing about the answer; the line comes
   * back in the new voice, which is the only demonstration worth having.
   * `voice` is null when the engine has only the one.
   */
  switchVoice(which: "female" | "male"): { said: string; voice: string | null } {
    const voice = this.settings.voiceChoices[which];
    if (!this.made.use(voice)) return { said: "This engine has only the one voice.", voice: null };
    return { said: `Switched to the ${which} voice.`, voice };
  }

  /**
   * 11.3 stop the playback the moment Chris starts to talk — all of it. Cutting
   * only the sentence in flight lets the queue drain into the gap, so the
   * bridge keeps talking and stops each sentence in turn, which sounds worse
   * than not stopping at all.
   *
   * The sentences are kept, not dropped. Until the bridge knows what Chris
   * said it cannot know whether they still matter, and the answer to that is a
   * transcription away — no clock is involved in the ordinary case.
   */
  hold(): void {
    if (this.holding) return;
    this.holding = true;
    // The one clock: a transcription that never comes back must not leave the
    // bridge silent with a passage stuck behind it.
    this.holdBackstop = setTimeout(() => this.discard(), this.settings.holdBackstopMs);
  }

  /** What Chris said does not change the answer: say the rest of it. */
  resume(): void {
    this.clearBackstop();
    if (!this.holding) return;
    this.holding = false;
    void this.pump();
  }

  /**
   * What Chris said replaces the answer: everything still queued goes.
   *
   * It is kept, not dropped. 11.10 says an answer he did not hear is still an
   * answer: "carry on" says it, the client shows it, and the agent is told
   * where he stopped, because its own context has the whole thing. What is
   * returned is that rest, for telling both.
   */
  discard(): readonly string[] {
    this.clearBackstop();
    this.holding = false;
    if (this.outbox.length > 0) this.tail = this.outbox.splice(0);
    // a bridge reply put back by the break in the pump is still waiting to be said
    if (this.ahead.length > 0) void this.pump();
    else this.settleIfIdle();
    return this.tail;
  }

  /**
   * 11.10 the rest of an answer a discard took off the queue, said once. False
   * when there is nothing left of it.
   *
   * It goes to the front of the answer queue: ahead of whatever is queued now,
   * because on 18 September the rest of a cut answer arrived after the whole
   * of the next one; and on the answer queue, not the reply queue, because
   * later that day it went through `reply`, nothing holds or discards that
   * queue, and the replay could not be stopped until it ran out. Every
   * "Stopped." and every new answer queued behind it: seven in a row when it
   * ended. It is an answer, so it holds and discards like one.
   */
  carryOn(): boolean {
    const rest = this.tail.splice(0);
    if (rest.length === 0) return false;
    this.outbox.unshift(...rest);
    void this.pump();
    return true;
  }

  /** Whether anything is queued, held or playing: the thing "end the turn" stops when no turn runs. */
  get busy(): boolean {
    return this.playing || this.holding || this.outbox.length > 0 || this.ahead.length > 0;
  }

  /** Resolves once nothing is queued and nothing is playing. */
  async drained(): Promise<void> {
    if (!this.pumping && !this.playing && this.ahead.length === 0 && this.outbox.length === 0) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /**
   * 15.2 a tone, never over the voice. One transport shares one audio source
   * and refuses a second writer: on 14 September the cue that marks the end of
   * a turn fired while the bridge was mid-sentence and the transport threw
   * `InvalidState - failed to capture frame`.
   */
  cue(name: CueName): void {
    if (!this.voice || this.playing) return;
    const wav = this.cues.file(name);
    if (wav) this.speaker.cue(wav, this.talking);
  }

  /** Sentences never overlap, and they keep their order (5.7). */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        // which queue it came from, so a cut sentence goes back to that one
        const jumped = this.ahead.length > 0;
        const text = this.ahead.shift() ?? (this.holding ? undefined : this.outbox.shift());
        if (text === undefined) break;
        this.playing = true;
        let whole = true;
        // the same choice the next turn of this loop will make, asked whenever
        // the sentence is made and about to play
        const next = (): string | undefined =>
          this.ahead[0] ?? (this.holding ? undefined : this.outbox[0]);
        try { whole = await this.speak(text, next); }
        catch { /* a transport that dropped is not this loop's problem */ }
        finally { this.playing = false; }
        // A sentence a barge-in cut is not a sentence Chris heard. It goes back
        // to the front of the queue it came from, so a resume starts it again
        // rather than carrying on from the middle of a word. A bridge reply
        // used to return to the answer queue instead, where the next
        // discard dropped it: "Muted." went unsaid.
        //
        // Either way it is not something he heard, so it never joins `heard`.
        // Reading `this.holding` after the await asked the wrong question: a
        // discard while the sentence was still playing flipped it, and a
        // sentence cut mid-word became the one `restate` read back.
        if (whole === false) {
          // Put it back and stop. A queue that jumps the hold used to retry the
          // sentence at once, be cut at once, and retry again for as long as
          // Chris kept talking: eighteen copies of one refusal in three seconds
          // on the drive of 18 September. Whatever resolves the utterance --
          // `resume`, `discard` -- starts the pump again.
          if (this.holding) { (jumped ? this.ahead : this.outbox).unshift(text); break; }
        } else this.heard.push(text);
      }
    } finally {
      this.pumping = false;
      this.settleIfIdle();
    }
  }

  /**
   * One sentence, made and played. `next` names the sentence after this one,
   * asked once this one is made: the agent streams its reply a few words at a
   * time, so at the moment a sentence begins the one after it has usually not
   * arrived, and a few seconds later it almost always has.
   */
  private async speak(text: string, next: () => string | undefined): Promise<boolean> {
    if (!this.voice) {
      // The round trip is still closed: the answer arrived, and how long that
      // took is the same question whether it is read or heard.
      this.measures.answering();
      const whole = await this.speaker.play(text, null, this.talking);
      this.measures.spoken(text, whole);
      return whole;
    }
    const madeAt = Date.now();
    const wav = await this.made.take(text);
    // 18.4 the first sound of the answer closes the round trip, and the engine's
    // share of it is told first. A later sentence is not a round trip, and the
    // tracker ignores both.
    this.measures.synthesized(Date.now() - madeAt);
    this.measures.answering();
    // The engine takes one request at a time, so this starts only now that
    // the current sentence is made. A barge-in during this prefetch makes
    // the bridge's next word wait for it, which costs one synthesis once and
    // saves one on every sentence of every answer.
    this.made.start(next());
    const whole = await this.speaker.play(text, wav, this.talking);
    this.measures.spoken(text, whole);
    return whole;
  }

  private clearBackstop(): void {
    if (this.holdBackstop) { clearTimeout(this.holdBackstop); this.holdBackstop = null; }
  }

  private settleIfIdle(): void {
    if (this.pumping || this.playing) return;
    if (this.ahead.length > 0 || this.outbox.length > 0) return;
    for (const done of this.waiters.splice(0)) done();
  }
}
