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
 * play -- and neither copy had a test. It is one place now, and the room is
 * its one loop (ADR 0010); it and a test supply only a `Speaker`, which plays
 * one wav.
 */
import { readdirSync } from "node:fs";
import { extname, join } from "node:path";
import { decodeWav, encodeWav, wavFromFile } from "./audio.ts";
import type { Config } from "./config.ts";
import type { CueName, Cues } from "./cues.ts";
import type { Measures } from "./measures.ts";
import { voiceSignature, type SpokenAhead } from "./speech.ts";

/** 15.10.1 how far before its stop a track picks up again, so the ear finds its place */
const HOLD_RESUME_BACK_MS = 2_000;

/** 15.8 the extensions of the files in the hold folder that are tracks */
const AUDIO = new Set([".mp3", ".wav", ".flac", ".ogg", ".opus", ".m4a", ".aac"]);

/** 15.8 one track of the hold music: decoded on first use, and where it plays from next, in samples. */
interface HoldTrack {
  file: string;
  samples: Promise<Int16Array | null> | null;
  at: number;
}

/** 15.8 the tracks in the folder, in file-name order. A folder with none is said once. */
function listTracks(folder: string, say?: (line: string) => void): HoldTrack[] {
  let names: string[];
  try {
    names = readdirSync(folder).filter((name) => AUDIO.has(extname(name).toLowerCase())).sort();
  } catch (error) {
    say?.(`[no hold music: ${(error as Error).message.split("\n")[0]}]`);
    return [];
  }
  if (names.length === 0) say?.(`[no hold music: no tracks in ${folder}]`);
  return names.map((name) => ({ file: join(folder, name), samples: null, at: 0 }));
}

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
  "Music on.",
  "Music off.",
  "Audio on.",
  "Audio off.",
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

/** How often an announcement asks whether the mouth is free. */
export const ANNOUNCE_POLL_MS = 500;

/**
 * 15.10.2 when a sound fades out rather than stops: from the first frame at
 * which `when` is true, the level falls in a straight line to nothing over
 * `ms`. A cut still stops it at once.
 */
/** 18.10 how many spoken sentences an echo is looked for in. */
const LATELY = 4;

/** 14.13 a sentence on a queue, and the answer it belongs to. A reply has none. */
export interface Queued {
  text: string;
  answer?: number;
}

export interface Fade {
  when: () => boolean;
  ms: number;
}

/** The part that plays one sound. The room and a test differ only here. */
export interface Speaker {
  /**
   * Play one sentence, made. False means a barge-in cut it short (11.3):
   * `cut` says whether Chris is talking, and a speaker that can stop between
   * frames asks it as it goes.
   *
   * `wav` is null when the audio is off (11.12): nothing is played, and the
   * words still go wherever the spoken ones are written down.
   */
  play(text: string, wav: string | null, cut: () => boolean): Promise<boolean>;
  /** 15.2 a tone. The mouth has checked that nothing is speaking. */
  cue(wav: string, cut: () => boolean): void;
  /**
   * 15.7 the hold music: a decoded track, played once. Null, and nothing
   * played, when the source is in use. Otherwise it resolves when the track
   * ends, false when `cut` stopped it or `fade` ran it out.
   */
  track(wav: Uint8Array, cut: () => boolean, fade: Fade): Promise<boolean> | null;
}

export class Mouth {
  private readonly outbox: Queued[] = [];
  private readonly ahead: Queued[] = [];
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
  /**
   * 18.10 the last few sentences the voice started, whole or cut, across turns.
   * `heard` holds only whole ones and is emptied each turn; an echo is loudest
   * in the sentence that was playing when the microphone heard it.
   */
  private lately: string[] = [];
  /** 11.12 whether the bridge makes any sound at all. The words go either way. */
  private audio = true;
  /** 18.4 whether the next sentence of the answer is the turn's first. */
  private firstOfTurn = true;
  /** 15.7 when the last sentence ended, which is where the silence is measured from */
  private voiceEndedAt = 0;
  /** 15.8 the tracks in the folder, in file-name order, listed on first use and never again. */
  private holdTracks: HoldTrack[] | null = null;
  /** 15.10.1 the turn of the track that the next silent stretch plays */
  private nextHoldTrack = 0;

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
    private readonly settings: {
      holdBackstopMs: number;
      voiceChoices: Config["voiceChoices"];
      talking?: () => boolean;
      /** 15.8 the hold music: the folder of tracks, the gain, and the rate the room plays at. Absent means none. */
      music?: { folder: string; gain: number; rate: number; fadeMs: number };
      /** 14.13 the voice reached this sentence, as it starts to play */
      speaking?: (sentence: Queued) => void;
      say?: (line: string) => void;
    },
  ) {
    this.talking = settings.talking ?? (() => false);
  }

  private readonly talking: () => boolean;

  /** What stops a sound at once: Chris talking, or the audio going off (11.12). */
  private readonly cutOff = (): boolean => this.talking() || !this.audio;

  /** One sentence of the answer. It is what a barge-in holds. */
  say(text: string, answer?: number): void {
    // 18.4 the collector's share ends here, whatever the queue does next
    if (this.firstOfTurn) { this.firstOfTurn = false; this.measures.firstSentence(); }
    this.outbox.push({ text, answer });
    void this.pump();
  }

  /**
   * One sentence from the bridge itself. It jumps a hold, because you asked now.
   * 11.11 an answer the agent began unasked jumps it too, and names its answer.
   */
  reply(text: string, answer?: number): void {
    this.ahead.push({ text, answer });
    void this.pump();
  }

  /**
   * A line from outside the conversation, such as "Job research finished".
   * It waits until `idle` says no turn runs, nothing is queued or playing, and
   * Chris is not talking, so it never lands inside an answer.
   */
  announce(text: string, idle: () => boolean): void {
    this.later.push(text);
    this.laterTimer ??= setInterval(() => {
      if (this.holding || this.occupied() || !idle()) return;
      const line = this.later.shift();
      if (line !== undefined) this.reply(line);
      if (this.later.length > 0) return;
      clearInterval(this.laterTimer!);
      this.laterTimer = null;
    }, ANNOUNCE_POLL_MS);
  }

  private readonly later: string[] = [];
  private laterTimer: ReturnType<typeof setInterval> | null = null;

  /** Whether a sentence is playing. A cue never goes over one. */
  get speaking(): boolean { return this.playing; }
  /** 11.3 whether an answer is waiting to find out what Chris just said. */
  get onHold(): boolean { return this.holding; }
  /** The sentences Chris heard this turn, whole, in order. */
  get said(): readonly string[] { return this.heard; }
  /** 18.10 the last few sentences the voice started, whole or cut, newest last. */
  get lastSpoken(): readonly string[] { return this.lately; }
  /** 15.7 when the last sentence ended, in milliseconds since the epoch. Zero before the first. */
  get lastVoiceAt(): number { return this.voiceEndedAt; }

  /** A turn begins: what he heard of the last one is the last one's. */
  newTurn(): void {
    this.heard = [];
    this.firstOfTurn = true;
  }

  /**
   * 11.12 the audio off skips the engine; the round trip still closes. A
   * sentence in flight and the hold music stop at once, through `cutOff`.
   */
  setAudio(on: boolean): void {
    this.audio = on;
  }

  /** 11.12 whether the bridge may make a sound. */
  get audioOn(): boolean { return this.audio; }

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
   * returned is what this call took, for telling both; a discard that took
   * nothing returns nothing, and the last rest stays kept for carry on. It
   * used to return the kept rest either way, and an interrupt of a turn that
   * was fully spoken reported an earlier turn's sentences as unspoken.
   */
  discard(): readonly string[] {
    this.clearBackstop();
    this.holding = false;
    const taken = this.outbox.splice(0).map((queued) => queued.text);
    if (taken.length > 0) this.tail = taken;
    // a bridge reply put back by the break in the pump is still waiting to be said
    if (this.ahead.length > 0) void this.pump();
    else this.settleIfIdle();
    return taken;
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
    this.outbox.unshift(...rest.map((text) => ({ text })));
    void this.pump();
    return true;
  }

  /**
   * Whether anything is queued or playing: the thing "end the turn" stops when
   * no turn runs. A hold with nothing behind it is not busy: the ear holds the
   * mouth on every barge-in, and a spoken command is a barge-in, so counting
   * the hold made "Nothing is running." unreachable from the room.
   */
  get busy(): boolean {
    return this.playing || this.track !== null || this.outbox.length > 0 || this.ahead.length > 0;
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
    if (!this.audio || this.playing || this.track) return;
    const wav = this.cues.file(name);
    if (wav) this.speaker.cue(wav, this.cutOff);
  }

  /**
   * 15.7 the hold music, one track, once. True when it started; the caller
   * does not wait for the end. It goes nowhere near a sentence, a cue or a
   * barge-in. A sentence fades it out (15.10.2); Chris talking, the audio
   * going off and `stop`, the caller's own, cut it at once.
   *
   * 15.10.1 each start plays the next track in file-name order, and the last
   * is followed by the first. A track that was stopped plays on from
   * `HOLD_RESUME_BACK_MS` before where it stopped; one that ended plays from
   * the start. The positions live only in this process.
   */
  async music(stop: () => boolean): Promise<boolean> {
    const { music } = this.settings;
    if (!music || !this.audio || this.occupied()) return false;
    this.holdTracks ??= listTracks(music.folder, this.settings.say);
    if (this.holdTracks.length === 0) return false;
    const track = this.holdTracks[this.nextHoldTrack % this.holdTracks.length]!;
    track.samples ??= wavFromFile(track.file, music.rate, music.gain).then((wav) => decodeWav(wav).samples, (error) => {
      this.settings.say?.(`[no hold music: ${(error as Error).message.split("\n")[0]}]`);
      return null;
    });
    const samples = await track.samples;
    // a track that cannot be read gives its turn to the next, which the caller asks for soon
    if (!samples) { this.nextHoldTrack++; return false; }
    // the first decode takes seconds: a sentence may have come since
    if (!this.audio || this.occupied() || stop()) return false;
    const from = track.at;
    const playing = this.speaker.track(encodeWav(samples.subarray(from), music.rate), () => this.cutOff() || stop(), { when: () => this.busy, ms: music.fadeMs });
    if (playing) {
      this.nextHoldTrack++;
      const startedAt = Date.now();
      void playing.then((whole) => {
        const resume = from + Math.round((Date.now() - startedAt - HOLD_RESUME_BACK_MS) * music.rate / 1_000);
        track.at = whole || resume >= samples.length ? 0 : Math.max(0, resume);
      });
    }
    return this.started("music", playing);
  }

  /**
   * 15.12 a file asked for from outside the conversation, through `/play`: a
   * preview, a recording, anything ffmpeg reads. It waits for the mouth the way
   * an announcement does, so the agent can ask for a track and say a sentence
   * about it in the same turn without the sentence cutting the track off one
   * second in. Once it plays, it plays as the hold music does: a sentence fades
   * it out, Chris talking and the audio off cut it.
   */
  play(wav: Uint8Array, fadeMs = 300): void {
    this.tracks.push({ wav, fadeMs });
    this.trackTimer ??= setInterval(() => {
      if (this.holding || this.occupied() || !this.audio) return;
      const next = this.tracks.shift();
      if (next) {
        const playing = this.speaker.track(next.wav, this.cutOff, { when: () => false, ms: next.fadeMs });
        if (playing) {
          // 15.12 a sentence waits for the track rather than cutting it: an
          // answer about a track that ends the track is the fault this fixed.
          this.track = playing;
          void playing.finally(() => { this.track = null; void this.pump(); });
        }
        this.started("file", playing);
      }
      if (this.tracks.length > 0) return;
      clearInterval(this.trackTimer!);
      this.trackTimer = null;
    }, ANNOUNCE_POLL_MS);
  }

  /** 15.7 the record says when a track started and when it stopped, or it cannot be checked after a drive. */
  private started(what: "music" | "file", playing: Promise<boolean> | null): boolean {
    if (!playing) return false;
    const at = Date.now();
    this.measures.trackStarted(what);
    void playing.then((whole) => this.measures.trackStopped(what, Date.now() - at, whole));
    return true;
  }

  /** 15.12 the track playing now, which a sentence waits for. Null when none is. */
  private track: Promise<boolean> | null = null;

  /** 15.12 the tracks asked for and not yet played. */
  private readonly tracks: Array<{ wav: Uint8Array; fadeMs: number }> = [];
  private trackTimer: ReturnType<typeof setInterval> | null = null;

  /** Chris is talking, or a sentence is queued or playing. */
  private occupied(): boolean {
    return this.talking() || this.busy;
  }

  /** Sentences never overlap, and they keep their order (5.7). */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        // 15.12 a track asked for holds the source until it ends or Chris talks
        if (this.track) await this.track;
        // which queue it came from, so a cut sentence goes back to that one
        const jumped = this.ahead.length > 0;
        const queued = this.ahead.shift() ?? (this.holding ? undefined : this.outbox.shift());
        if (queued === undefined) break;
        const { text } = queued;
        this.playing = true;
        // 14.13 the voice reached this sentence: a client lights the words as
        // they are said rather than as they arrive.
        this.settings.speaking?.(queued);
        this.lately.push(text);
        if (this.lately.length > LATELY) this.lately.shift();
        let whole = true;
        // the same choice the next turn of this loop will make, asked whenever
        // the sentence is made and about to play
        const next = (): string | undefined =>
          (this.ahead[0] ?? (this.holding ? undefined : this.outbox[0]))?.text;
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
          if (this.holding) { (jumped ? this.ahead : this.outbox).unshift(queued); break; }
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
    if (!this.audio) {
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
    // A sentence the audio going off stopped is said as words, as every later
    // one is: it counts as heard, and it is not put back for a resume.
    const whole = (await this.speaker.play(text, wav, this.cutOff)) || !this.audio;
    this.voiceEndedAt = Date.now();
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
