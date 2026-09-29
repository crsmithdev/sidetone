#!/usr/bin/env bun
/**
 * Test 17 in docs/testing.md: score each Whisper model on the clips the
 * transcription card kept, in `~/.sidetone/heard/`.
 *
 *   bun scripts/score-models.ts --since "2026-09-29 10:00"
 *   bun scripts/score-models.ts --since "-3 hours" --models tiny.en,small.en --python ~/sidetone/.venv/bin/python
 *   bun scripts/score-models.ts --no-prompt       without the vocabulary prompt
 *
 * The journal names the line each utterance answered. A clip gets the label of
 * the first journal line after it, and only the last clip before that line
 * gets it: an earlier clip is a tentative end (18.4) or a line said again, and
 * gets no label. Only the last full run of the card is scored.
 *
 * Each model runs in the bridge's own worker (`speech/stt_worker.py` through
 * `LocalWhisper`), with the bridge's vocabulary prompt, one model at a time
 * beside the running bridge. The decode time is the round trip of one
 * `transcribe`, after one untimed pass that pays the first decode. The GPU
 * memory is the peak of the `nvidia-smi` total less the total before the
 * worker started, so it counts anything else that grew on the GPU meanwhile.
 * The texts go to --out, not to the repo: they are Chris's voice.
 */
import { readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { TRANSCRIPTION_CARD, match } from "../src/commands.ts";
import { loadConfig } from "../src/config.ts";
import { LocalWhisper } from "../src/speech.ts";

const MODELS = [
  "tiny.en", "base.en", "small.en", "medium.en", "distil-small.en", "distil-medium.en",
  "large-v3", "distil-large-v3", "distil-large-v3.5", "large-v3-turbo",
];

const { values } = parseArgs({
  options: {
    since: { type: "string", default: "-3 hours" },
    models: { type: "string", default: MODELS.join(",") },
    python: { type: "string" },
    heard: { type: "string", default: join(homedir(), ".sidetone", "heard") },
    out: { type: "string", default: join(homedir(), ".sidetone", "scores.json") },
    "no-prompt": { type: "boolean", default: false },
  },
});

type Clip = { wav: string; at: number };
type Labelled = Clip & { line: number; round: number };

/** Lower case, and all but letters and digits made a space, as test 17 compares words. */
function words(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean);
}

function wordErrors(want: string[], got: string[]): number {
  let previous = Array.from({ length: got.length + 1 }, (_, i) => i);
  for (let i = 1; i <= want.length; i++) {
    const current = [i];
    for (let j = 1; j <= got.length; j++) {
      current[j] = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + (want[i - 1] === got[j - 1] ? 0 : 1));
    }
    previous = current;
  }
  return previous[got.length]!;
}

function clips(dir: string): Clip[] {
  return readdirSync(dir).filter((name) => name.endsWith(".wav"))
    .map((name) => ({ wav: join(dir, name), at: Number(name.split("-")[0]) }))
    .sort((a, b) => a.at - b.at);
}

/** The card lines of the journal: when each was heard, and its place on the card. */
function cardLines(since: string): Array<{ at: number; round: number; line: number }> {
  const run = Bun.spawnSync(["journalctl", "--user", "-u", "sidetone.service", "--since", since, "-o", "short-iso-precise"]);
  const found: Array<{ at: number; round: number; line: number }> = [];
  for (const text of run.stdout.toString().split("\n")) {
    const place = /^(\S+) .*\[the card, round (\d+), line (\d+), "([^"]*)"/.exec(text);
    if (!place) continue;
    const line = Number(place[3]);
    // an older card, of other lines, is not this card
    if (TRANSCRIPTION_CARD[line - 1]?.say !== place[4]) continue;
    found.push({ at: Date.parse(place[1]!), round: Number(place[2]), line });
  }
  // the last full run: from the last round 1, line 1
  let start = -1;
  found.forEach((entry, i) => { if (entry.round === 1 && entry.line === 1) start = i; });
  return start < 0 ? [] : found.slice(start);
}

function label(all: Clip[], lines: ReturnType<typeof cardLines>): { labelled: Labelled[]; spare: Clip[]; other: Clip[] } {
  const first = lines[0]!.at - 60_000;
  const last = lines.at(-1)!.at;
  const inRun = all.filter((clip) => clip.at >= first && clip.at <= last);
  const labelled: Labelled[] = [];
  for (const [i, entry] of lines.entries()) {
    const before = i === 0 ? first : lines[i - 1]!.at;
    const answer = inRun.filter((clip) => clip.at > before && clip.at <= entry.at).at(-1);
    if (answer) labelled.push({ ...answer, line: entry.line, round: entry.round });
  }
  const kept = new Set(labelled.map((clip) => clip.wav));
  const spare = inRun.filter((clip) => !kept.has(clip.wav));
  const other = all.filter((clip) => clip.at < first || clip.at > last);
  return { labelled, spare, other };
}

/** Total GPU memory in use, in MiB, from nvidia-smi. */
function gpuUsed(): number {
  const smi = Bun.which("nvidia-smi") ?? "/usr/lib/wsl/lib/nvidia-smi";
  const run = Bun.spawnSync([smi, "--query-gpu=memory.used", "--format=csv,noheader,nounits"]);
  return Number(run.stdout.toString().trim().split("\n")[0]);
}

function median(numbers: number[]): number {
  const sorted = [...numbers].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

const lines = cardLines(values.since!);
if (lines.length === 0) throw new Error(`no run of the card in the journal since ${values.since}`);
const { labelled, spare, other } = label(clips(values.heard!), lines);
console.log(`card lines in the journal: ${lines.length}; labelled clips: ${labelled.length}; spare clips in the run: ${spare.length}; other clips: ${other.length}`);

const base = loadConfig();
const config = {
  ...base,
  ...(values.python ? { pythonBin: values.python } : {}),
  // an empty vocabulary sends no initial prompt
  ...(values["no-prompt"] ? { sttVocabulary: [] } : {}),
};
const speechDir = new URL("../speech", import.meta.url).pathname;
const results: Record<string, unknown>[] = [];

for (const model of values.models!.split(",")) {
  const baseline = gpuUsed();
  let peak = baseline;
  const poll = setInterval(() => { peak = Math.max(peak, gpuUsed()); }, 100);
  const stt = new LocalWhisper({ ...config, sttModel: model }, speechDir);
  try {
    await stt.start();
    // The warmup is a second of silence, which vad_filter drops, so the first
    // real clip still pays the decoder's first run. Pay it here, untimed.
    const warmed = performance.now();
    await stt.transcribe(labelled[0]!.wav);
    const firstMs = Math.round(performance.now() - warmed);
    const clipResults = [];
    for (const clip of labelled) {
      const started = performance.now();
      const text = await stt.transcribe(clip.wav);
      const ms = performance.now() - started;
      const card = TRANSCRIPTION_CARD[clip.line - 1]!;
      const want = words(card.say);
      const got = words(text);
      const errors = wordErrors(want, got);
      const heard = match(text, config.wakeWord, false, config.mutedCommands, config.wakeWordVariants);
      const matched = card.want === "speech" ? heard.kind === "speech" : heard.kind === "command" && heard.name === card.want;
      clipResults.push({ round: clip.round, line: clip.line, text, ms: Math.round(ms), errors, words: want.length, exact: errors === 0, matched });
    }
    peak = Math.max(peak, gpuUsed());
    const errors = clipResults.reduce((sum, c) => sum + c.errors, 0);
    const total = clipResults.reduce((sum, c) => sum + c.words, 0);
    const ms = clipResults.map((c) => c.ms);
    const result = {
      model, warmupSeconds: stt.warmupSeconds, firstMs, wer: errors / total,
      exact: clipResults.filter((c) => c.exact).length,
      commandsMatched: clipResults.filter((c) => TRANSCRIPTION_CARD[c.line - 1]!.want !== "speech" && c.matched).length,
      clips: clipResults.length, medianMs: median(ms), worstMs: Math.max(...ms), gpuMiB: peak - baseline, results: clipResults,
    };
    results.push(result);
    console.log(`${model}: WER ${(result.wer * 100).toFixed(1)}%, exact ${result.exact}/${result.clips}, commands ${result.commandsMatched}, median ${result.medianMs} ms, worst ${result.worstMs} ms, first ${firstMs} ms, GPU ${result.gpuMiB} MiB`);
  } catch (error) {
    results.push({ model, error: String(error) });
    console.log(`${model}: did not run: ${error}`);
  } finally {
    clearInterval(poll);
    stt.stop();
    await Bun.sleep(3000);
  }
}

writeFileSync(values.out!, JSON.stringify({ labelled, spare, other: other.length, results }, null, 2));
console.log(`wrote ${values.out}`);
