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

/**
 * 5.7.1 a path or a file name in the text. A run of word characters, dots,
 * slashes, tildes and hyphens that holds a letter and either a slash or a
 * word of two or more characters followed by a dot and a short extension of
 * letters. The run ends on a word character or a slash, so the full stop
 * after a path stays a full stop. "3.5", "1.2.3", "e.g.", "U.S." and
 * "23/09/2026" are not paths.
 */
const PATH = /[\w~.\/-]*[\w\/]/g;
const IS_PATH = /^(?=.*[A-Za-z])(?:.*\/|.*\w{2,}\.[A-Za-z]{1,5}$)/;

/**
 * 5.7.1 the text as the voice can say it: each path in it becomes words.
 * `src/sentences.ts` becomes "S R C slash sentences dot T S". A part of the
 * path with no vowel is spelled, because the cloning voice cannot say "src"
 * and loops on ".ts": on 24 September the sentence that named
 * `src/sentences.ts` looped in 9 takes of 15, and this form in 0 of 20. The
 * screen and the record keep the written form; only the engine sees this one.
 */
export function speakable(text: string): string {
  return text.replace(PATH, (run) => {
    if (!IS_PATH.test(run)) return run;
    const parts = run.replace(/~/g, "home").replace(/\//g, " slash ").replace(/\./g, " dot ").trim().split(/\s+/);
    return parts.map((part) => /^[a-z]+$/i.test(part) && !/[aeiou]/i.test(part) ? [...part.toUpperCase()].join(" ") : part).join(" ");
  });
}
