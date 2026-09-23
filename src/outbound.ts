/**
 * The one exit for the control channel (14.11).
 *
 * Before this the room was reached as `void transport.send(message)`. Three
 * faults sat in that line. `publishData` rejects when the room drops mid-call,
 * nothing caught it, and an unhandled rejection exits Bun, so one failed
 * message took the whole bridge down and the agent session with it. Nothing
 * measured a payload against what a data message may carry. And nothing kept
 * two messages in order: each was a promise nobody waited for, so a `delta`
 * and the `sentence` that finishes it could reach the client either way round,
 * against 14.9.
 *
 * So one module encodes, measures, orders and catches. A failure is a line in
 * the journal, never an exit.
 */
import type { Outgoing } from "./messages.ts";

/**
 * What one data message may carry.
 *
 * Measured against this machine's own LiveKit on 22 September 2026, in a room
 * of its own: a payload of 62,996 bytes arrives, and 63,996 is refused with
 * `data packet size (64035 bytes) exceeds the negotiated maximum`. The publish
 * rejects; nothing is truncated and nothing arrives. So the limit is a packet
 * of about 64,000 bytes, and the envelope is about 39 of them.
 *
 * The comments in the code said 12 to 15 KiB, which is the figure the app
 * splits its own parts at. This is the measured one, with room to spare.
 */
export const MAX_MESSAGE_BYTES = 60_000;

export class Outbound {
  /** The messages go out in the order they were given, one at a time. */
  private last: Promise<void> = Promise.resolve();

  constructor(
    private readonly publish: (payload: Uint8Array) => Promise<void>,
    private readonly say: (line: string) => void = console.log,
  ) {}

  /**
   * Send one message. It returns at once: the caller is the conversation, and
   * a turn does not wait on the wire.
   */
  send(message: Outgoing): void {
    const payload = this.fitted(message);
    this.last = this.last.then(() => this.publish(payload)).catch((error) => {
      // 14.11 the client asks for what it missed when it comes back; a message
      // that did not go is not worth the process.
      this.say(`[a ${message.kind} message did not reach the client: ${(error as Error).message}]`);
    });
  }

  /** Everything that has been given to it has gone out, or failed. For a test. */
  async drained(): Promise<void> {
    await this.last;
  }

  /**
   * 14.8 the history is the one message with no bound on it: forty kept turns,
   * each holding a whole answer. A client that comes back wants the newest of
   * them, so the oldest go until it fits. Every other kind is sent as it is,
   * because the true limit is a comment rather than a measurement, and a
   * transcript trimmed on a guess is worse than a large message.
   */
  private fitted(message: Outgoing): Uint8Array {
    let payload = encode(message);
    if (payload.byteLength <= MAX_MESSAGE_BYTES) return payload;
    if (message.kind !== "history") {
      this.say(`[a ${message.kind} message is ${payload.byteLength} bytes, over the ${MAX_MESSAGE_BYTES} a data message carries]`);
      return payload;
    }
    const turns = [...message.turns];
    while (turns.length > 1 && payload.byteLength > MAX_MESSAGE_BYTES) {
      turns.shift();
      payload = encode({ ...message, turns });
    }
    this.say(`[the history was trimmed to the newest ${turns.length} of ${message.turns.length} turns to fit one message]`);
    return payload;
  }
}

function encode(message: Outgoing): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message));
}
