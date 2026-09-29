#!/usr/bin/env bun
/**
 * What the detector would have done with the recorded turns, had it ended
 * them (spec 18.18, item 54 b).
 *
 *   bun scripts/turn-replay.ts                    the record in ~/.sidetone
 *   bun scripts/turn-replay.ts --record <file>    another record
 *
 * Each `turnGuess` line is one tentative end. A guess at or above the
 * threshold ends the turn when its score comes back: `quietMs` plus
 * `inferenceMs` after Chris stopped. Speech that came back before the score
 * ends nothing. Then:
 *
 * - ended on the pause: caught. The pause saved is the pause setting less the
 *   moment of the detector end.
 * - resumed, and the bridge heard the speech inside the window: joined. The
 *   cost is one agent start that the bridge cancels. The window is the quiet
 *   from Chris's last word to the moment the bridge hears him again, as the
 *   pause is.
 * - resumed after the window: a real cut-off. The first part went to the agent
 *   alone, and the rest is a barge-in.
 *
 * The bridge hears speech `speechOnsetMs` after it comes back, so the gap is
 * `resumedAfterMs` plus that.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config.ts";
import type { TurnGuess } from "../src/diagnostics.ts";

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const path = option("--record") ?? join(homedir(), ".sidetone", "record.jsonl");

const PAUSE_MS = DEFAULTS.endOfTurnPauseMs;
const ONSET_MS = DEFAULTS.speechOnsetMs;
const THRESHOLDS = [0.5, 0.7, 0.8, 0.9, 0.95, 0.97, 0.99];
const WINDOWS = [700, 900, 1200, PAUSE_MS];

type Line = Record<string, any>;
const lines: Line[] = (await Bun.file(path).text()).split("\n").filter(Boolean).map((line) => JSON.parse(line));
const guesses = lines.filter((line): line is TurnGuess => line.kind === "turnGuess" && line.probability !== null);
// an agent turn: a line with no agentMs is the bridge's own reply
const answered = lines.filter((line) => line.kind === "answered" && line.pauseMs === PAUSE_MS && typeof line.agentMs === "number");

const median = (values: number[]) => {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const pct = (part: number, whole: number) => `${Math.round((100 * part) / whole)}%`;

// the early transcription starts at the tentative end, so the text can come
// after the detector end: the round trip cannot start before it
const read = lines.filter((line) => line.kind === "heard" && line.transcribeMs > 0).map((line) => line.transcribeMs);
const READ_MS = median(read);

const pauseEnds = guesses.filter((g) => g.outcome === "ended" && g.endedBy === "pause");
const resumed = guesses.filter((g) => g.outcome === "resumed");
console.log(`${path}: ${guesses.length} guesses with a score. ${pauseEnds.length} ended on the pause, ${resumed.length} resumed, ${guesses.length - pauseEnds.length - resumed.length} other (flush or cut).`);
console.log(`pause ${PAUSE_MS} ms, onset ${ONSET_MS} ms. A window of ${PAUSE_MS} ms closes when the pause would have ended the turn: no resume in the record falls outside it.\n`);

console.log("| threshold | window ms | detector ends | caught (of pause ends) | median pause saved ms | joined | cut off | round trip saved, s total | per pause end, ms | per pause end, text-bound, ms |");
console.log("|---|---|---|---|---|---|---|---|---|---|");
for (const threshold of THRESHOLDS) {
  for (const window of WINDOWS) {
    const endAt = (g: TurnGuess) => g.quietMs + (g.inferenceMs ?? 0);
    const early = guesses.filter((g) => g.probability! >= threshold && (g.outcome !== "resumed" || g.resumedAfterMs! > endAt(g)));
    const caught = early.filter((g) => g.outcome === "ended" && g.endedBy === "pause");
    const saved = caught.map((g) => PAUSE_MS - endAt(g));
    const back = early.filter((g) => g.outcome === "resumed");
    const joined = back.filter((g) => g.resumedAfterMs! + ONSET_MS <= window);
    const total = saved.reduce((a, b) => a + b, 0);
    const bound = caught.map((g) => PAUSE_MS - Math.max(endAt(g), g.quietMs + READ_MS)).reduce((a, b) => a + b, 0);
    console.log(`| ${threshold} | ${window} | ${early.length} | ${caught.length} (${pct(caught.length, pauseEnds.length)}) | ${Math.round(median(saved))} | ${joined.length} | ${back.length - joined.length} | ${(total / 1000).toFixed(0)} | ${Math.round(total / pauseEnds.length)} | ${Math.round(bound / pauseEnds.length)} |`);
  }
}

// how soon the voice starts after the pause today: a detector end moves it up by
// the pause saved, and a voice that starts inside the window blocks the retract
const afterPause = answered.map((a) => a.answerMs - PAUSE_MS).sort((a, b) => a - b);
const at = (q: number) => afterPause[Math.min(afterPause.length - 1, Math.floor(q * afterPause.length))];
console.log(`\nThe agent's first word after the end of a turn, from ${afterPause.length} answered lines: min ${at(0)} ms, 5th percentile ${at(0.05)}, median ${at(0.5)}.`);
// a detector end at about 500 ms of quiet puts the first word inside a window of the whole pause when it comes within 1,000 ms
const inside = afterPause.filter((ms) => ms < PAUSE_MS - 500).length;
console.log(`${inside} of ${afterPause.length} (${pct(inside, afterPause.length)}) would speak inside a ${PAUSE_MS} ms window, where a resume is a barge-in and not a join.`);
console.log(`A full transcription, where the early one was not used (${read.length} heard lines): median ${READ_MS} ms. The text-bound column takes the early one to need that long from the tentative end.`);
console.log(`
What the record cannot show:
- speech that came back after ${PAUSE_MS} ms of quiet: the pause had ended that utterance, as it does today, so it is no resume here.
- how long the early transcription took: the text-bound column is an estimate from full transcriptions.
- whether a joined utterance reads as well as one, and what an interrupt within a second of the start costs the agent.
- a resume in a turn whose voice started inside the window: the line above says how often the voice could.
- whether a guess fell while the hold to talk button was down, where the detector ends nothing.`);
