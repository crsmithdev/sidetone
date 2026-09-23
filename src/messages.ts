/**
 * The control channel's vocabulary (spec 4.3), in one place.
 *
 * There are three clients of this: the bridge, the page in `client/` and the
 * Android app. Each used to restate it, and on 17 September 2026 the app and
 * the page disagreed about a refused token for half a day. The types below
 * are what `Channel` may send at all, so a kind cannot be added on one end
 * only. `sentence` was, on 19 September, and the page said "unknown message"
 * until the vocabulary caught up.
 *
 * The bridge used to send a map of the kinds on every join, and no client
 * read it. The check now is `test/fixtures/messages.jsonl`: a bridge test
 * writes what the bridge really sends, and the page, the app and the fake
 * phone each decode that file in a test of their own (ADR 0007).
 */
import type { Config } from "./config.ts";

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
   * above the words that came between. The agent's own turn after a
   * background task names one too (11.11).
   */
  | { kind: "sentence"; text: string; answer: number }
  | { kind: "turn"; number: number; text: string; costUsd: number; answer: number }
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
  | { kind: "protocol"; endTurn: string; apk?: Apk }
  /** 17.15.5 a new build while the client is in the room; `protocol` would reset more than the offer */
  | { kind: "apk"; apk: Apk }
  /**
   * 14.12.7 what became of a screenshot the phone sent: it waits for the next
   * turn, a turn took it, it waited too long, or Chris dropped it. The app
   * shows the mark on the thumbnail from this.
   */
  | { kind: "screenshot"; id: string; state: "pending" | "sent" | "expired" | "dropped" };

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
  return { kind: "protocol", endTurn: endTurnPhrase(config), ...(apk ? { apk } : {}) };
}

/**
 * 12.4 what makes a token worth throwing away, rather than retrying.
 *
 * Livekit reports a token it cannot verify as "invalid API key", with the text
 * in the message and a number in the reason, so a client reads both.
 */
export const REFUSED = "unauthor|invalid token|invalid api key|expired|permission|denied|403|401";
