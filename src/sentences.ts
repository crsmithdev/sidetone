/**
 * 5.6 collect the streamed words to the end of a sentence.
 *
 * The point is latency: 5.7 speaks one sentence while the model still writes
 * the next, so the time to the first audio (16.5) is the time to the first
 * sentence, not the time to the whole reply.
 *
 * Splitting too eagerly costs a small pause. Splitting too late holds the
 * audio back. This errs toward splitting, and never waits for punctuation
 * that may not arrive.
 */
const CLOSERS = `.!?"')]`;

export class SentenceCollector {
  private buffer = "";

  constructor(private readonly maxChars: number) {}

  /** The complete sentences this text finishes. The rest waits for more. */
  push(text: string): string[] {
    this.buffer += text;
    const out: string[] = [];
    for (;;) {
      const at = this.boundary();
      if (at < 0) break;
      const sentence = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at);
      if (sentence) out.push(sentence);
    }
    // a long run with no punctuation at all must not hold the audio back
    while (this.buffer.length > this.maxChars) {
      const space = this.buffer.lastIndexOf(" ", this.maxChars);
      const at = space > 0 ? space : this.maxChars;
      const chunk = this.buffer.slice(0, at).trim();
      this.buffer = this.buffer.slice(at);
      if (chunk) out.push(chunk);
    }
    return out;
  }

  /** 5.5 the reply ended, so whatever is left is a sentence whether it looks like one or not. */
  flush(): string | null {
    const rest = this.buffer.trim();
    this.buffer = "";
    return rest || null;
  }

  /** The index one past the end of the first sentence, or -1 while it is not certain. */
  private boundary(): number {
    for (let i = 0; i < this.buffer.length; i++) {
      const ch = this.buffer[i] as string;
      if (ch === "\n") return i + 1;
      if (ch !== "." && ch !== "!" && ch !== "?") continue;
      // 3.5 and 1.2.3 are numbers, not the ends of sentences
      if (ch === "." && /\d/.test(this.buffer[i - 1] ?? "") && /\d/.test(this.buffer[i + 1] ?? "")) continue;
      let j = i + 1;
      while (j < this.buffer.length && CLOSERS.includes(this.buffer[j] as string)) j++;
      // the punctuation is the last thing here: more text may still make it a number or an ellipsis
      if (j >= this.buffer.length) return -1;
      if (/\s/.test(this.buffer[j] as string)) return j;
    }
    return -1;
  }
}

/** 15.7.4 the word the agent starts a reply with when it expects the turn to take a while. */
export const LONG_MARKER = "[long]";

/** A reply as the room hears it: the marker, and the space after it, are not part of the words. */
export function withoutMarker(text: string): string {
  return text.startsWith(LONG_MARKER) ? text.slice(LONG_MARKER.length).trimStart() : text;
}

/**
 * 15.7.4 takes the marker off the front of a reply as the deltas arrive.
 *
 * The marker can arrive split across deltas, so a start that could still
 * become the marker is held until it is certain. Only the very start of the
 * reply counts: once the reply has other words, or a tool call, the marker
 * is not looked for again and is left in the text.
 */
export class LongMarker {
  private state: "start" | "trim" | "done" = "start";
  private held = "";
  /** whether the reply began with the marker */
  long = false;

  /** The text of this delta, without the marker. It may be empty while the start is held. */
  push(text: string): string {
    if (this.state === "done") return text;
    if (this.state === "trim") return this.trim(text);
    this.held += text;
    if (LONG_MARKER.startsWith(this.held) && this.held !== LONG_MARKER) return "";
    const whole = this.held;
    this.held = "";
    if (!whole.startsWith(LONG_MARKER)) { this.state = "done"; return whole; }
    this.long = true;
    this.state = "trim";
    return this.trim(whole.slice(LONG_MARKER.length));
  }

  /** The reply ended, or a tool call began: whatever is held is words after all, and the start is over. */
  end(): string {
    const held = this.held;
    this.held = "";
    this.state = "done";
    return held;
  }

  private trim(text: string): string {
    const rest = text.trimStart();
    if (rest) this.state = "done";
    return rest;
  }
}
