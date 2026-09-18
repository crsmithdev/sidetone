/**
 * The control channel's vocabulary (spec 4.3), in one place.
 *
 * There are three clients of this: the bridge, the page in `client/` and the
 * Android app. Each used to restate it, and on 17 September 2026 the app and
 * the page disagreed about a refused token for half a day. The bridge is the
 * writer now: it injects this into the page it serves, and sends it to any
 * client that joins the room.
 */
import type { Config } from "./config.ts";

/** What the bridge sends, and how a client shows it. */
export const INCOMING = {
  /** what Chris said, as the engine wrote it */
  heard: "you",
  /** what the agent answered */
  turn: "bridge",
  /** 2.3 what the bridge says while a tool runs */
  narration: "note",
  error: "note",
  /** 14.8 the turns a client missed; kinds inside it are heard and turn */
  history: "history",
  /** this message: the words a client needs that only the bridge knows */
  protocol: "protocol",
} as const;

/**
 * What a client sends. `voice` cuts the speech and leaves the words: the
 * transcript is a data message and does not go down the audio path, so a bridge
 * with its voice off is still a whole conversation, read rather than heard.
 */
export const OUTGOING = ["said", "mic", "quality", "voice"] as const;

/**
 * 9.4.8 the Stop button, said in words, because the bridge hears commands and
 * does not take buttons. Built from the wake word, so changing that setting
 * does not leave every client saying a phrase nobody answers to.
 */
export function endTurnPhrase(config: Config): string {
  return `${config.wakeWord} end the turn`;
}

/** What a client is told when it joins. */
export function protocolMessage(config: Config): Record<string, unknown> {
  return { kind: "protocol", endTurn: endTurnPhrase(config), incoming: INCOMING, outgoing: OUTGOING };
}

/**
 * 12.4 what makes a token worth throwing away, rather than retrying.
 *
 * Livekit reports a token it cannot verify as "invalid API key", with the text
 * in the message and a number in the reason, so a client reads both.
 */
export const REFUSED = "unauthor|invalid token|invalid api key|expired|permission|denied|403|401";
