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
 * the room and not a person. This says so. It decides nothing — a person may
 * read a sentence back — but it goes in the record, which is what turns a
 * failure that took a drive to notice into one the first minute shows.
 */

/** The words of a line, lowercase, without punctuation. */
function words(line: string): string[] {
  return line.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

/**
 * Below this an utterance is too short to tell apart from a command or a
 * coincidence: "stop", "yes", "carry on" are all things the bridge says too.
 */
const SHORTEST = 4;

/** How much of the utterance has to be in the sentence before it is an echo. */
const ENOUGH = 0.7;

/**
 * The sentence this utterance echoes, or null. `spoken` is what the voice has
 * said lately, newest last.
 */
export function echoOf(said: string, spoken: readonly string[]): string | null {
  const heard = words(said);
  if (heard.length < SHORTEST) return null;
  for (const sentence of [...spoken].reverse()) {
    const inSentence = new Set(words(sentence));
    if (inSentence.size === 0) continue;
    const shared = heard.filter((word) => inSentence.has(word)).length;
    if (shared / heard.length >= ENOUGH) return sentence;
  }
  return null;
}
