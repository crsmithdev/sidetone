#!/usr/bin/env bun
/**
 * The round trip, one speech engine against another, from a fixed script
 * (docs/latency.md, items 5 and 82).
 *
 *   bun scripts/latency-bench.ts                                  every engine pair in DEFAULT_*
 *   bun scripts/latency-bench.ts --stt small.en --tts kokoro --runs 1
 *   bun scripts/latency-bench.ts --out ~/bench/2026-10-20
 *   bun scripts/latency-bench.ts --report ~/.sidetone/bench/2026-10-20   the table again, from the files
 *
 * Each pair is one run of `fake-phone.ts` with a config of its own: the
 * speech-to-text model, the voice, and a record file of its own, so the bench
 * never writes to the real record. The prompts are the same every run and
 * need no tool, so the agent's share stays short and comparable.
 *
 * The split is the one the record already keeps (src/latency.ts):
 *
 * - local: transcription waited for, and the first sentence to sound. This is
 *   the part on this machine. Transcription starts inside the pause, so it is
 *   usually zero.
 * - agent: the text went in, the first whole sentence came back. Claude Code
 *   over the network. The first word to the first sentence is the agent's
 *   writing, so it is here and not in local.
 * - pause: the end-of-turn pause, a setting.
 * - phone: the first audio the phone hears, from the end of what it said.
 *   It includes the pause, the agent and the network back.
 *
 * A line the bridge heard as nothing gets no `answered` line, so `turns` less
 * than the prompts means the speech-to-text model lost lines.
 *
 * VRAM is not measured: fake-phone loads its own copy of the same engines.
 *
 * It costs money and needs the network and LiveKit, so it is not part of
 * `bun test`.
 */
import { mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { ENGINES } from "../src/speech.ts";

const DEFAULT_STT = ["tiny.en", "base.en", "small.en", "medium.en", "distil-medium.en"];
const DEFAULT_TTS = ["piper", "kokoro", "chatterbox"] as const;

/** The first prompt opens the session and fills the cache; it is not counted. */
const WARM_UP = "Say the word ready.";
const PROMPTS = [
  "What is the capital of France?",
  "Give me one tip for sleeping better.",
  "How many minutes are there in a day?",
  "What does a sidetone do on a telephone?",
  "Name a good book about distributed systems.",
  "What is the boiling point of water in Fahrenheit?",
  "Tell me a short fact about octopuses.",
  "What is a good name for a grey cat?",
  "How far is the moon, roughly?",
  "What year did the first iPhone come out?",
];

interface Options { stt: string[]; tts: string[]; runs: number; out: string; report: string }

function parse(argv: string[]): Options {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  const options: Options = { stt: DEFAULT_STT, tts: [...DEFAULT_TTS], runs: 1, out: join(homedir(), ".sidetone", "bench", stamp), report: "" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--stt") options.stt = (argv[++i] as string).split(",");
    else if (arg === "--tts") options.tts = (argv[++i] as string).split(",");
    else if (arg === "--runs") options.runs = Number(argv[++i]);
    else if (arg === "--out") options.out = argv[++i] as string;
    else if (arg === "--report") options.report = argv[++i] as string;
    else { console.error(`unknown argument: ${arg}`); process.exit(2); }
  }
  for (const tts of options.tts) {
    if (!(tts in ENGINES)) { console.error(`unknown voice engine: ${tts}`); process.exit(2); }
  }
  return options;
}

function quantile(values: number[], q: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
}

interface Answered { pauseMs: number; transcribeMs: number; answerMs: number; agentMs: number; sentenceMs: number; synthesisMs: number }

interface Pair {
  stt: string; tts: string; lines: number; turns: number;
  localMs: number[]; agentMs: number[]; pauseMs: number[]; answerMs: number[]; phoneMs: number[];
}

/** Run one pair through fake-phone. Its record and its output land in `out`. */
async function runPair(stt: string, tts: string, options: Options): Promise<void> {
  const name = `${stt}+${tts}`;
  const recordPath = join(options.out, `${name}.jsonl`);
  const configPath = join(options.out, `${name}.config.json`);
  // the live config can turn the bridge's sound off (11.12.3), and a bench with no sound measures nothing
  const config = { ...loadConfig(), sttModel: stt, ttsEngine: tts, ...ENGINES[tts as keyof typeof ENGINES].voices, recordPath, audio: true };
  await Bun.write(configPath, JSON.stringify(config, null, 2));

  const lines = [WARM_UP];
  for (let run = 0; run < options.runs; run++) lines.push(...PROMPTS);

  console.log(`--- ${name}: ${lines.length} lines`);
  const child = Bun.spawn(["bun", "scripts/fake-phone.ts", ...lines], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, SIDETONE_CONFIG: configPath },
    stdout: "pipe", stderr: "inherit",
  });
  const output = await new Response(child.stdout).text();
  const code = await child.exited;
  if (code !== 0) console.error(`${name}: fake-phone exited ${code}; read ${name}.log`);
  await Bun.write(join(options.out, `${name}.log`), output);
}

/** Read one pair back from its record and its fake-phone output. */
async function readPair(dir: string, name: string): Promise<Pair> {
  const [stt, tts] = name.split("+") as [string, string];
  const output = await Bun.file(join(dir, `${name}.log`)).text();
  const measured = [...output.matchAll(/^\s*line (\d+): (.*)$/gm)];
  // fake-phone's own measurement: "line 3: first audio 4.2s after the question ended, pause included"
  const phoneMs = measured
    .filter((m) => Number(m[1]) > 1)
    .map((m) => /first audio ([\d.]+)s after the question ended/.exec(m[2] as string))
    .filter((found) => found !== null)
    .map((found) => Number(found[1]) * 1000);

  const recordPath = join(dir, `${name}.jsonl`);
  const record = await Bun.file(recordPath).exists() ? await Bun.file(recordPath).text() : "";
  const answered = record.split("\n").filter(Boolean)
    .map((line) => JSON.parse(line) as { kind: string } & Answered)
    .filter((line) => line.kind === "answered" && line.agentMs > 0)
    .slice(1);

  return {
    stt, tts, lines: Math.max(0, measured.length - 1), turns: answered.length,
    localMs: answered.map((a) => a.transcribeMs + a.synthesisMs),
    agentMs: answered.map((a) => a.agentMs + a.sentenceMs),
    pauseMs: answered.map((a) => a.pauseMs),
    answerMs: answered.map((a) => a.answerMs),
    phoneMs,
  };
}

const options = parse(process.argv.slice(2));
const dir = options.report || options.out;
let names: string[];
if (options.report) {
  names = readdirSync(dir).filter((file) => file.endsWith(".log")).map((file) => file.slice(0, -".log".length));
  const order = (name: string) => {
    const [stt, tts] = name.split("+") as [string, string];
    return DEFAULT_TTS.indexOf(tts as typeof DEFAULT_TTS[number]) * 100 + DEFAULT_STT.indexOf(stt);
  };
  names.sort((a, b) => order(a) - order(b));
} else {
  mkdirSync(dir, { recursive: true });
  names = [];
  for (const tts of options.tts) {
    for (const stt of options.stt) {
      await runPair(stt, tts, options);
      names.push(`${stt}+${tts}`);
    }
  }
}

const pairs = await Promise.all(names.map((name) => readPair(dir, name)));
await Bun.write(join(dir, "summary.json"), JSON.stringify(pairs, null, 2));

const s = (values: number[], q: number) => {
  const v = quantile(values, q);
  return Number.isNaN(v) ? "-" : (v / 1000).toFixed(2);
};
console.log(`\n${dir}\n`);
console.log("| STT | TTS | turns | local p50 | local p95 | agent p50 | agent p95 | pause | round trip p50 | round trip p95 | phone p50 | phone p95 |");
console.log("|---|---|---|---|---|---|---|---|---|---|---|---|");
for (const p of pairs) {
  console.log(`| ${p.stt} | ${p.tts} | ${p.turns}/${p.lines} | ${s(p.localMs, 0.5)} | ${s(p.localMs, 0.95)} | ${s(p.agentMs, 0.5)} | ${s(p.agentMs, 0.95)} | ${s(p.pauseMs, 0.5)} | ${s(p.answerMs, 0.5)} | ${s(p.answerMs, 0.95)} | ${s(p.phoneMs, 0.5)} | ${s(p.phoneMs, 0.95)} |`);
}
