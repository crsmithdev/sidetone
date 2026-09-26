#!/usr/bin/env bun
/**
 * Where the agent's time to the first word goes, one variant of its command
 * line against another (docs/round-trip-plan.md, phase 1).
 *
 *   bun scripts/first-word.ts                 5 rounds of the prompts, every variant
 *   bun scripts/first-word.ts --runs 2 --only baseline,haiku --dir ~/sidetone
 *
 * Each variant is one `claude` process with the bridge's own command line
 * (src/conversation.ts), in the project the bridge runs in, asked what Chris
 * would ask. A round is every prompt once, and the prompts go in as the
 * bridge sends them, after the verbosity line. One turn before the rounds
 * opens the process and is not counted, as the first turn of a session pays
 * for the cache the rest read. The turns go through the bridge's `Latency`,
 * so the numbers mean what they mean on an `answered` line of the record.
 *
 * A permission request is denied: the prompts need none, and the check must
 * not run a command the bridge would have asked Chris about. It costs money
 * and needs the network, so it is not part of `bun test`.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { VERBOSITY_LINES } from "../src/conversation.ts";
import { ASK_RULES } from "../src/gated.ts";
import { Latency, type TimedRound } from "../src/latency.ts";
import { linesOf, parseLine } from "../src/protocol.ts";

type Line = Record<string, any>;

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const runs = Number(option("--runs") ?? 5);
const dir = option("--dir") ?? process.env.SIDETONE_DIR ?? join(homedir(), "sidetone");
if (!Number.isInteger(runs) || runs < 1) { console.error("--runs takes a whole number above 0"); process.exit(2); }

const config = loadConfig();
/** The bridge's own command line, without the model. */
const bridge = [
  config.claudeBin, ...config.claudeArgs,
  "--append-system-prompt", config.voiceInstruction,
  "--permission-prompt-tool", "stdio",
  "--settings", JSON.stringify({ permissions: { ask: ASK_RULES } }),
];

const VARIANTS: Record<string, string[]> = {
  baseline: ["--model", config.model],
  "effort low": ["--model", config.model, "--effort", "low"],
  "five tools": ["--model", config.model, "--tools", "Bash,Read,Edit,Glob,Grep"],
  haiku: ["--model", "haiku"],
};
const only = option("--only")?.split(",");
const variants = Object.entries(VARIANTS).filter(([name]) => !only || only.includes(name));

/** Spoken, short, and answerable with no tool, except the last, which needs one Read. */
const PROMPTS: Array<{ text: string; read: boolean }> = [
  { text: "Quick one, what's seventeen times twenty three?", read: false },
  { text: "What's a good way to remember the order of the planets?", read: false },
  { text: "In a sentence, why is a warm cache faster than a cold one?", read: false },
  { text: "Read CONTEXT.md and tell me what it calls the agent.", read: true },
];
const WARM_UP = "Hello, can you hear me?";
const TURN_TIMEOUT_MS = 180_000;

/** `costUsd` is the session's total so far, as the result gives it. */
interface Measured { prompt: number; round: TimedRound; tools: number; costUsd: number }

/** One `claude` process, one turn at a time. */
class Claude {
  private child: ReturnType<typeof Bun.spawn>;
  private onLine: ((line: Line) => void) | null = null;
  init: Line | null = null;
  exitedEarly = "";

  constructor(extra: string[]) {
    this.child = Bun.spawn([...bridge, ...extra], { cwd: dir, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    this.read();
    new Response(this.child.stderr as ReadableStream).text().then((text) => { this.exitedEarly = text.trim(); });
  }

  private async read(): Promise<void> {
    for await (const text of linesOf(this.child.stdout as ReadableStream<Uint8Array>)) {
      let line: Line;
      try { line = JSON.parse(text); } catch { continue; }
      if (line.type === "system" && line.subtype === "init") this.init = line;
      if (line.type === "control_request" && line.request?.subtype === "can_use_tool") {
        this.write({ type: "control_response", response: { subtype: "success", request_id: line.request_id, response: { behavior: "deny", message: "Denied by the first-word check. Do not try again." } } });
      }
      this.onLine?.(line);
    }
  }

  private write(message: unknown): void {
    const stdin = this.child.stdin as import("bun").FileSink;
    stdin.write(`${JSON.stringify(message)}\n`);
    stdin.flush();
  }

  /** Say `text` as the bridge does, and time the turn as the bridge does: from the words going in. */
  turn(text: string): Promise<Omit<Measured, "prompt"> | null> {
    const latency = new Latency();
    let tools = 0;
    return new Promise((resolve) => {
      const timer = setTimeout(() => { this.onLine = null; resolve(null); }, TURN_TIMEOUT_MS);
      this.onLine = (line) => {
        const at = Date.now();
        if (line.type === "assistant") tools += (line.message?.content ?? []).filter((part: Line) => part.type === "tool_use").length;
        for (const event of parseLine(JSON.stringify(line))) {
          latency.agent(event, at);
          if (event.kind === "delta") latency.firstDelta(at);
          if (event.kind === "result") {
            clearTimeout(timer);
            this.onLine = null;
            resolve({ round: latency.answered(at)!, tools, costUsd: event.costUsd });
          }
        }
      };
      const now = Date.now();
      latency.speechEnded(now, now);
      latency.transcribed(now);
      this.write({ type: "user", message: { role: "user", content: [VERBOSITY_LINES[config.verbosity], text].join("\n\n") } });
    });
  }

  stop(): void {
    try { this.child.kill(); } catch { /* already gone */ }
  }
}

function quantile(values: number[], q: number): number {
  if (!values.length) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];
}
const seconds = (ms: number) => Number.isNaN(ms) ? "–" : (ms / 1000).toFixed(2);

/** The built-in tools the process offers; the MCP tools come as their servers connect, so they are not counted. */
let builtIn = 0;
/** What the warm-up turn cost, which the total of the measured turns leaves out. */
let warmUpUsd = 0;

async function measure(name: string, extra: string[]): Promise<Measured[]> {
  const claude = new Claude(extra);
  const measured: Measured[] = [];
  try {
    const warm = await claude.turn(WARM_UP);
    if (!warm) { console.error(`${name}: the warm-up turn gave no result. ${claude.exitedEarly}`); return measured; }
    warmUpUsd = warm.costUsd;
    builtIn = (claude.init?.tools ?? []).filter((tool: string) => !tool.startsWith("mcp__")).length;
    console.error(`${name}: ${claude.init?.model}, ${builtIn} built-in tools, warm-up ${seconds(warm.round.agentMs)} s`);
    for (let run = 0; run < runs; run++) {
      for (const [prompt, { text }] of PROMPTS.entries()) {
        const turn = await claude.turn(text);
        if (!turn) { console.error(`${name}: no result in ${TURN_TIMEOUT_MS / 1000} s for "${text}"`); continue; }
        measured.push({ prompt, ...turn });
        const r = turn.round;
        console.error(`${name} ${run + 1}.${prompt + 1}: ${seconds(r.agentMs)} s, first ${r.firstEvent}, ${turn.tools} tools, thinking ${r.thinkingTokens ?? "–"}`);
      }
    }
  } finally {
    claude.stop();
  }
  return measured;
}

const rows: string[] = [];
for (const [name, extra] of variants) {
  const measured = await measure(name, extra);
  const first = (m: Measured[]) => m.map((x) => x.round.agentMs).filter((ms) => ms > 0);
  const plain = measured.filter((m) => !PROMPTS[m.prompt].read);
  const read = measured.filter((m) => PROMPTS[m.prompt].read);
  const reads = measured.map((m) => m.round.cacheReadTokens ?? 0).reduce((a, b) => a + b, 0);
  const all = measured.map((m) => (m.round.inputTokens ?? 0) + (m.round.cacheReadTokens ?? 0) + (m.round.cacheCreationTokens ?? 0)).reduce((a, b) => a + b, 0);
  const thinking = measured.map((m) => m.round.thinkingTokens ?? 0);
  const prompt = measured.map((m) => (m.round.inputTokens ?? 0) + (m.round.cacheReadTokens ?? 0) + (m.round.cacheCreationTokens ?? 0));
  const cost = measured.length ? measured[measured.length - 1].costUsd - warmUpUsd : 0;
  rows.push([
    name, builtIn, measured.length,
    seconds(quantile(first(measured), 0.5)), seconds(quantile(first(measured), 0.9)),
    seconds(quantile(first(plain), 0.5)), seconds(quantile(first(read), 0.5)),
    all ? `${Math.round((100 * reads) / all)}%` : "–",
    Math.round(quantile(prompt, 0.5)),
    quantile(thinking, 0.5), quantile(thinking, 0.9),
    `$${cost.toFixed(3)}`,
  ].join(" | "));
}

console.log([
  `claude ${Bun.spawnSync([config.claudeBin, "--version"]).stdout.toString().trim()}, ${runs} rounds of ${PROMPTS.length} prompts, in ${dir}. Times are to the first text delta, in seconds.`,
  "",
  "| variant | built-in tools | turns | p50 | p90 | p50 no tool | p50 Read | cache read | prompt tokens p50 | thinking p50 | thinking p90 | cost |",
  "|---|---|---|---|---|---|---|---|---|---|---|---|",
  ...rows.map((row) => `| ${row} |`),
].join("\n"));
