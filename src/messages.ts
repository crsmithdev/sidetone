/**
 * The control channel's vocabulary (spec 4.3), in one place.
 *
 * There are three clients of this: the bridge, the page in `client/` and the
 * Android app. Each used to restate it, and on 17 September 2026 the app and
 * the page disagreed about a refused token for half a day. The bridge is the
 * writer now: it sends this to any client that joins the room, and the types
 * below are what `Channel` may send at all, so a kind cannot be added on one
 * end only. `sentence` was, on 19 September, and the page said "unknown
 * message" until the vocabulary caught up.
 */
import type { Config } from "./config.ts";

/** What the bridge sends, and how a client shows it. */
export const INCOMING = {
  /** what Chris said, as the engine wrote it */
  heard: "you",
  /** 14.7 one sentence of the answer, as soon as it is known */
  sentence: "bridge",
  /** 14.9 a block of the answer begins: a client that shows a bubble for each block starts one */
  blockStart: "bridge",
  /** 14.9 the words of the block, as the agent writes them; a client with bubbles grows the block's bubble */
  delta: "bridge",
  /** 14.9 the block is complete; a client shows nothing */
  blockEnd: "none",
  /** what the agent answered, whole */
  turn: "bridge",
  /** 2.3 what the bridge says while a tool runs */
  narration: "note",
  error: "note",
  /** 14.8 the turns a client missed; kinds inside it are heard and turn */
  history: "history",
  /** this message: the words a client needs that only the bridge knows */
  protocol: "protocol",
  /** 18.9 leave the room and join it again; a client shows nothing */
  rejoin: "none",
  /** 14.10 whether the agent works; the app shows a sign, the page shows nothing */
  working: "none",
  /** 9.4.9 the settings in force, when a client joins and whenever one changes; a client shows them where it can */
  settings: "none",
  /** 14.13 the voice reached this sentence; a client lights the words as they are said */
  speaking: "none",
} as const;

/**
 * What a client sends. `voice` cuts all the audio and leaves the words: the
 * transcript is a data message and does not go down the audio path, so a bridge
 * with its audio off is still a whole conversation, read rather than heard. The
 * kind kept the name it had when the voice was all the audio there was.
 * `screen` is one part of the app's screen log (14.11); the bridge writes the log to disk.
 * `screenshot` is one part of a screenshot from the phone (14.12); the bridge writes the image to disk.
 * `setting` changes one setting, and does exactly what the spoken command does,
 * down to the voice saying so: a client cannot do more by tapping than by talking.
 */
export const OUTGOING = ["said", "mic", "quality", "voice", "screen", "screenshot", "setting"] as const;

/** 14.8 a line a returning client is given again: what Chris said and what was answered. */
export type Kept =
  | { kind: "heard"; text: string; at: number }
  | { kind: "turn"; number: number; text: string; costUsd: number; at: number };

/** Everything the bridge sends a client, and nothing else. */
export type Outgoing =
  | { kind: "heard"; text: string }
  /**
   * 14.7 `answer` names the answer a sentence belongs to, and the turn that
   * closes it. A client grows one line per answer: an interrupted answer
   * sends no turn, and without the name the next answer grew on its line,
   * above the words that came between. A turn without one, the agent's own
   * after a background task, is a line of its own.
   */
  | { kind: "sentence"; text: string; answer: number }
  | { kind: "turn"; number: number; text: string; costUsd: number; answer?: number }
  /**
   * 14.9 a block of an answer that holds text. `block` counts from 1 within the
   * answer, and the same two numbers name the block in the words that follow it.
   * A delta comes before the sentence that finishes with it.
   */
  | { kind: "blockStart"; answer: number; block: number }
  | { kind: "delta"; text: string; answer: number; block: number }
  | { kind: "blockEnd"; answer: number; block: number }
  /** 17.17 `announce` marks a line that `/say` queued, such as the end of a job; the app notifies it */
  | { kind: "narration"; text: string; announce?: true }
  | { kind: "error"; text: string }
  | { kind: "history"; turns: Kept[] }
  | { kind: "rejoin" }
  /** 14.10 a turn runs or a detached job runs; sent when it changes, and again every few seconds while it holds */
  | { kind: "working"; on: boolean }
  /**
   * 9.4.9 the settings in force. A client that can show a setting has to be
   * able to read one: before this a client could set a setting by sending the
   * words of the command, and had no way at all to know what it was now.
   */
  | { kind: "settings"; settings: Record<string, unknown> }
  /**
   * 14.13 the voice started this sentence. A `sentence` message says the words
   * are known; this says they are being heard, which is a different moment: the
   * engine takes a fraction of a second and the queue can be seconds long. A
   * sentence a barge-in cut is said again from the start, so this can repeat.
   */
  | { kind: "speaking"; text: string; answer?: number }
  | { kind: "protocol"; endTurn: string; incoming: typeof INCOMING; outgoing: typeof OUTGOING; apk?: Apk };

/** 17.15 the app the bridge serves: where to fetch it, and its SHA-256 in hex. */
export interface Apk {
  url: string;
  sha256: string;
}

/**
 * 9.4.8 the Stop button, said in words, because the bridge hears commands and
 * does not take buttons. Built from the wake word, so changing that setting
 * does not leave every client saying a phrase nobody answers to.
 */
export function endTurnPhrase(config: Config): string {
  return `${config.wakeWord} end the turn`;
}

/** What a client is told when it joins. 17.15 `apk` is there when the bridge has an app to serve. */
export function protocolMessage(config: Config, apk?: Apk): Outgoing {
  return { kind: "protocol", endTurn: endTurnPhrase(config), incoming: INCOMING, outgoing: OUTGOING, ...(apk ? { apk } : {}) };
}

/**
 * 12.4 what makes a token worth throwing away, rather than retrying.
 *
 * Livekit reports a token it cannot verify as "invalid API key", with the text
 * in the message and a number in the reason, so a client reads both.
 */
export const REFUSED = "unauthor|invalid token|invalid api key|expired|permission|denied|403|401";
