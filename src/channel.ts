/**
 * The control channel: what the bridge tells a client, and what it hears from
 * one (spec 4.3, 14.7, 14.8).
 *
 * It used to be written from six places. The conversation reached the client
 * three ways, and which lines a returning client got back depended on which of
 * the three the author had picked; the room's messages were read in a closure
 * in `serve.ts` that no test entered, and every finding of the drive of
 * 18 September landed there as another branch. This is the one place now. The
 * room hands it `transport.send`; a test hands it an array.
 *
 * It sends, keeps what a returning client is owed, and writes the journal
 * line. It decides nothing about the conversation: what a message does is the
 * conversation's, the ear's and the mouth's, which it reaches through `Ends`.
 */
import { settingsInForce, type Config } from "./config.ts";
import { protocolMessage, type Apk, type Kept, type Outgoing } from "./messages.ts";
import { qualityOf, type Quality, type Side } from "./network.ts";

/** What a client's message does, in the modules that own it. */
export interface Ends {
  /** a thing Chris said, typed rather than spoken */
  heard(text: string): Promise<void>;
  /**
   * ADR 0008 the phone opened or cut its microphone; anything half recorded
   * goes with a cut. `hold` says the hold to talk button made the change: a
   * cut with it is a release, and ends a finished utterance (9.5.2).
   */
  microphone(on: boolean, hold: boolean): void;
  /** 11.12 the audio off leaves the words */
  voice(on: boolean): void;
  /** N.1 a reading of the connection; true when it is news */
  quality(side: Side, quality: Quality): boolean;
  /** 9.4.9 a setting a client changed, in the same words the config uses */
  setting(patch: Record<string, unknown>): void;
  /** 14.11 one part of the phone's screen log; what to say about it, if anything */
  screen(part: Record<string, unknown>): string[];
  /** 14.12 one part of a screenshot from the phone; what to say about it, if anything */
  screenshot(part: Record<string, unknown>): string[];
}

/** The ear's reading of a dead microphone, as `Ear.silence` gives it. */
export type Silence = { kind: "no frames" | "silence"; ms: number } | null;

/** 14.7 the light transcript is a window, not a log. */
const KEPT = 40;

export class Channel {
  private readonly kept: Kept[] = [];
  /** whether the phone says its microphone is open; the bridge only warns about one it claims to have */
  private micOn = true;
  private saidSilent = false;

  constructor(
    private readonly config: Config,
    private readonly send: (message: Outgoing) => void,
    private readonly ends: Ends,
    private readonly say: (line: string) => void = console.log,
    /** 11.12 the settings that belong to this run rather than to the file. */
    private readonly live?: () => Record<string, unknown>,
  ) {}

  /** Say it to the client. A word said or answered is kept for 14.8; a note is written to the journal. */
  tell(message: Outgoing): void {
    if (message.kind === "heard" || message.kind === "turn") {
      this.kept.push({ ...message, at: Date.now() });
      if (this.kept.length > KEPT) this.kept.shift();
    }
    if (message.kind === "narration" || message.kind === "error") this.say(`[${message.text}]`);
    this.send(message);
  }

  /**
   * 9.4.9 the settings in force, whenever they change and when a client joins.
   * `live` names the ones that are not in the config file: the audio, which is
   * this run's own state and the one a client most needs to read back.
   */
  settings(): void {
    this.send({ kind: "settings", settings: { ...settingsInForce(this.config), ...this.live?.() } });
  }

  /** 2.3 what the bridge says about itself, on the journal and in the client. */
  narrate(text: string): void {
    this.tell({ kind: "narration", text });
  }

  /** What the bridge records and does not show: the journal only (4.3.1). */
  journal(text: string): void {
    this.say(`[${text}]`);
  }

  /**
   * 4.3 a client that joins is told the words it has to say back, then what it
   * missed (14.8). 17.15 `apk` is the app the bridge serves, if it has one.
   */
  joined(apk?: Apk): void {
    this.send(protocolMessage(this.config, apk));
    this.settings();
    this.send({ kind: "history", turns: this.missed() });
  }

  /**
   * 14.8 what a client missed while it was away, which is a drop in a tunnel,
   * measured in minutes. An exchange from hours ago is not that: it arrives
   * looking like the conversation in progress, and the reader cannot tell.
   */
  missed(now = Date.now()): Kept[] {
    return this.kept.filter((entry) => now - entry.at <= this.config.historyMaxAgeMs);
  }

  /** One message from a client. A kind this end does not know is dropped. */
  receive(value: Record<string, unknown>): void {
    if (value.kind === "said" && typeof value.text === "string") { void this.ends.heard(value.text); return; }
    if (value.kind === "mic") {
      this.micOn = value.on !== false;
      this.saidSilent = false;
      // 9.5.1 an open says `hold`, and 9.5.2 a cut says `release`
      const hold = this.micOn ? value.hold === true : value.release === true;
      const release = !this.micOn && hold;
      this.ends.microphone(this.micOn, hold);
      this.say(`[the phone ${this.micOn ? "opened" : "cut"} its microphone${release ? " and ended the utterance" : ""}]`);
      return;
    }
    if (value.kind === "voice") {
      const on = value.on !== false;
      this.ends.voice(on);
      // 4.3.1 the app shows its own state; the note said it a second time
      this.journal(on ? "the audio is on" : "the audio is off; the words carry on in the transcript");
      return;
    }
    // 9.4.9 a setting a client changed. It does what the spoken command does.
    if (value.kind === "setting" && value.patch && typeof value.patch === "object") {
      this.ends.setting(value.patch as Record<string, unknown>);
      return;
    }
    if (value.kind === "screen") {
      // 14.11 the log streams, so where it goes is the journal's business, not a note
      for (const line of this.ends.screen(value)) this.journal(line);
      return;
    }
    if (value.kind === "screenshot") {
      // 14.12 the same as the screen log: the journal, not a note
      for (const line of this.ends.screenshot(value)) this.journal(line);
      return;
    }
    // N.1.4 the phone's own reading of its uplink. It is the same signal this
    // end sees, arriving twice, and it is kept because it is the one that
    // survives a link the bridge has stopped hearing from.
    if (value.kind === "quality") this.quality("phone", value.quality);
  }

  /** N.1 a reading of the connection from either end, said when it changes. */
  quality(side: Side, value: unknown): void {
    const seen = qualityOf(value);
    if (this.ends.quality(side, seen)) this.say(`[${side === "bridge" ? "this end" : "the phone"} reports ${seen}]`);
  }

  /**
   * 18 a microphone that publishes nothing, or publishes zeroes, is the failure
   * Chris drove twenty minutes with. The track belongs to the phone, so this
   * end cannot mend it; it says so once, and says what does mend it, and says
   * it again only after the microphone has come back.
   *
   * 18.9 the phone can mend it by leaving the room and joining again, so the
   * first reading of an episode also asks the phone to do that. The phone
   * limits how often it agrees.
   */
  silence(reading: Silence): void {
    if (!this.micOn || !reading) { this.saidSilent = false; return; }
    if (this.saidSilent) return;
    this.saidSilent = true;
    const seconds = Math.round(reading.ms / 1000);
    const text = reading.kind === "no frames"
      ? `no audio from the phone for ${seconds}s, though it says its microphone is open`
      : `the phone's microphone has carried no sound at all for ${seconds}s`;
    // 18.9.2 the app shows the rejoin in its status light
    this.journal(`${text}. Leave the room and rejoin to publish a new track`);
    this.send({ kind: "rejoin" });
    this.say("[asked the phone to rejoin]");
  }
}
