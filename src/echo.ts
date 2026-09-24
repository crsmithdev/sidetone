/**
 * Whether the bridge just heard itself (spec 18.10).
 *
 * The volume slider of 21 September was never wrong in the barge-in logic. It
 * shipped a gain the phone's echo canceller could not hold, so the microphone
 * heard the speaker, the bridge treated its own voice as Chris talking, and it
 * barged in on itself. Nothing in the code could tell: an utterance is an
 * utterance, whoever said it.
 *
 * The one thing that separates the two is the words. The bridge knows exactly
 * what it has just said, so an utterance that repeats it is almost certainly
 * the room and not a person. This says so, and it goes in the record, which is
 * what turns a failure that took a drive to notice into one the first minute
 * shows. The conversation drops a match only when the utterance also began
 * while the voice played, because a person may read a sentence back.
 */

import type { Barged, Event, Heard, Spoke } from "./diagnostics.ts";

/** The words of a line, lowercase, without punctuation. */
function words(line: string): string[] {
  return line.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

/**
 * Below this an utterance is too short to tell apart from a command or a
 * coincidence: "stop", "yes", "carry on" are all things the bridge says too.
 */
const SHORTEST = 4;

/**
 * An utterance that began this long after the voice stopped can still be its
 * echo: the room and the transcription delay the sound.
 */
export const ECHO_AFTER_MS = 1_000;

/** How much of the utterance has to be in the sentence before it is an echo. */
const ENOUGH = 0.7;

/**
 * How close the letters of the utterance have to come to some stretch of the
 * sentence. A garbled echo splits and joins words ("screen shot" for
 * "screenshot"), so the word count falls under `ENOUGH` while the letters
 * still match. Over the record of 20 to 23 September, the echoes scored 0.8
 * to 1.0 and what Chris said over the voice scored 0.65 and under.
 */
const CLOSE = 0.8;

/**
 * The share of `heard`'s letters that match the closest stretch of `sentence`:
 * one less the edit distance to that stretch, over the length of `heard`.
 */
export function likeness(heard: string, sentence: string): number {
  const a = words(heard).join("");
  const b = words(sentence).join("");
  if (a.length === 0) return 0;
  // a stretch may start anywhere in `b`, so the first row costs nothing
  let row = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j]! + 1, next[j - 1]! + 1, row[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return 1 - Math.min(...row) / a.length;
}

/**
 * The sentence this utterance echoes, or null. `spoken` is what the voice has
 * said lately, newest last.
 */
export function echoOf(said: string, spoken: readonly string[]): string | null {
  const heard = words(said);
  if (heard.length < SHORTEST) return null;
  const matches = (sentence: string): boolean => {
    const inSentence = new Set(words(sentence));
    if (inSentence.size === 0) return false;
    const shared = heard.filter((word) => inSentence.has(word)).length;
    return shared / heard.length >= ENOUGH || likeness(said, sentence) >= CLOSE;
  };
  for (const sentence of [...spoken].reverse()) if (matches(sentence)) return sentence;
  // 18.10.3 one utterance may cover a run of sentences. The ear ends an
  // utterance on a pause, and a passage played into a room has none it can
  // hear, so the whole run comes back as one line and no single sentence holds
  // seven words in ten of it. The car of 23 September brought back four
  // sentences at once and matched none of them.
  if (spoken.length > 1) {
    const run = spoken.join(" ");
    if (matches(run)) return run;
  }
  return null;
}

/** 18.13 what the echo check found: 0 a pass, 1 an echo, 2 no way to tell. */
export interface EchoCheck { code: 0 | 1 | 2; word: string; lines: string[] }

/**
 * 18.13 read the record of the echo check. `events` start when the bridge was
 * asked to say `passage`, and nothing after `until` counts. Nobody talks during
 * the check, so anything the ear heard came from the room.
 */
export function verdict(events: readonly Event[], passage: readonly string[], until: number): EchoCheck {
  const within = events.filter((e) => e.at <= until);
  const heard = within.filter((e): e is Heard => e.kind === "heard");
  const echoes = heard.filter((e) => echoOf(e.text, passage) !== null);
  const others = heard.filter((e) => !echoes.includes(e) && words(e.text).length > 0);
  const barged = within.filter((e): e is Barged => e.kind === "barged");
  const cut = within.filter((e): e is Spoke => e.kind === "spoke" && !e.whole);
  const lines = [
    ...heard.map((e) => `heard ${JSON.stringify(e.text)}, peak ${e.peak.toFixed(2)}${echoes.includes(e) ? ", an echo" : ""}`),
    ...barged.map((e) => `a barge-in, level ${e.level.toFixed(2)}`),
    ...cut.map((e) => `cut short: ${JSON.stringify(e.text)}`),
  ];
  if (echoes.length > 0 || cut.length > 0) return { code: 1, word: "FAIL: the microphone brought the passage back", lines };
  if (others.length > 0) return { code: 2, word: "CANNOT TELL: somebody spoke; run it again in a quiet room", lines };
  if (barged.length > 0) return { code: 1, word: "FAIL: the ear heard sound over the voice, and nobody spoke", lines };
  return { code: 0, word: "PASS: the room stayed quiet while the passage played", lines };
}
