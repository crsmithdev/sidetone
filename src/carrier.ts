/**
 * A fixed reply the voice never says cleanly on its own, cut out of a
 * sentence it does say (spec 11.6.3).
 *
 * The cloning voice garbles a line of one word most of the time, and
 * "Stopped." it garbled in every take measured on 24 September. The same word
 * at the end of "The answer has stopped." came out clean in every take. So the
 * voice says the carrier, the speech worker says when each word was said, and
 * the line's own words are cut out by those times. The cut is then checked
 * like any other take: it has to transcribe back to its own text, or it is
 * not kept.
 */
import { cutWav, decodeWav, encodeWav } from "./audio.ts";
import type { HeardWord, SpeechToText } from "./speech.ts";

/**
 * The cut starts this much before the first word, when there is room before
 * the word that came before, so an onset the alignment put a little late is
 * not lost. The worker's word times come from the cross-attention of the
 * model, which places a boundary within a few hundredths of a second.
 */
const LEAD_S = 0.1;
/** The same after the last word, when another word follows it. */
const TAIL_S = 0.1;

/**
 * Where the line's words sit in what was heard, in seconds: from the start of
 * the first to the end of the last. `before` is the end of the word before the
 * line, or the line's own start when it opens the carrier; `after` is the
 * start of the word after it, or null when the line ends the carrier. Null when
 * the words were not heard, whole and in order.
 *
 * The last run of the words is the line. A carrier ends with the line, and
 * may say the words earlier too: "I stopped the answer. Stopped." holds
 * "stopped" twice, and the first, measured 24 September, cut to "stop" in 9
 * takes of 10 because the word ran on into the next.
 */
export function spanOf(heard: readonly HeardWord[], text: string): { from: number; to: number; before: number; after: number | null } | null {
  const own = words(text);
  if (own.length === 0 || heard.length < own.length) return null;
  const said = heard.map((w) => words(w.word).join(""));
  for (let at = heard.length - own.length; at >= 0; at--) {
    if (!own.every((word, i) => said[at + i] === word)) continue;
    const first = heard[at]!;
    const last = heard[at + own.length - 1]!;
    const next = heard[at + own.length];
    return { from: first.start, to: last.end, before: at > 0 ? heard[at - 1]!.end : first.start, after: next ? next.start : null };
  }
  return null;
}

/** The words of a line as the check compares them: letters and digits, lower case. */
function words(line: string): string[] {
  return line.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
}

/**
 * 11.6.3 the cut the warm command makes: the speech worker times the words of
 * the carrier take, and the line's own words are written to `out`. False, and
 * nothing written, when the take did not hold the line.
 */
export function clipCutter(stt: Pick<SpeechToText, "transcribeWords">): (carrierWav: string, text: string, out: string) => Promise<boolean> {
  return async (carrierWav, text, out) => {
    const { words: heard } = await stt.transcribeWords(carrierWav);
    const span = spanOf(heard, text);
    if (!span) return false;
    const wav = decodeWav(await Bun.file(carrierWav).bytes());
    const from = Math.max(span.before, span.from - LEAD_S);
    const to = span.after === null ? Number.POSITIVE_INFINITY : Math.min(span.after, span.to + TAIL_S);
    const cut = cutWav(wav, from, to);
    await Bun.write(out, encodeWav(cut.samples, cut.sampleRate, cut.channels));
    return true;
  };
}
