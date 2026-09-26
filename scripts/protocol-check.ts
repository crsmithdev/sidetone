#!/usr/bin/env bun
/**
 * The Claude Code stream facts the bridge depends on, measured again (spec 16.2).
 *
 * None of these is a promised interface, so each Claude Code upgrade can move
 * one. This drives the real `claude` with the flags the bridge uses, text in
 * and no audio, and counts how many runs of each fact hold.
 *
 *   bun scripts/protocol-check.ts                    one run of each fact, on Haiku
 *   bun scripts/protocol-check.ts --runs 3 --model sonnet
 *
 * Each run is its own process in its own temporary directory. A run that
 * fails prints why on stderr as it happens. It costs money and needs the
 * network, so it is not part of `bun test`. It exits 0 when every run of
 * every fact holds, and 1 otherwise.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { ASK_RULES } from "../src/gated.ts";
import { linesOf } from "../src/protocol.ts";

type Line = Record<string, any>;

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const runs = Number(option("--runs") ?? 1);
const model = option("--model") ?? "haiku";
if (!Number.isInteger(runs) || runs < 1) { console.error("--runs takes a whole number above 0"); process.exit(2); }

const config = loadConfig();
/** The bridge's own command line (src/conversation.ts), with the model asked for here. */
const command = [
  config.claudeBin, ...config.claudeArgs,
  "--append-system-prompt", config.voiceInstruction,
  "--permission-prompt-tool", "stdio",
  "--settings", JSON.stringify({ permissions: { ask: ASK_RULES } }),
  "--model", model,
];

/** How long a run waits after its last expected result for one it did not expect. */
const SETTLE_MS = 8_000;
const RUN_TIMEOUT_MS = 180_000;

/** One `claude` process: every line it prints, and a way to wait for one. */
class Claude {
  readonly lines: Line[] = [];
  private waiting: Array<{ test(line: Line): boolean; resolve(line: Line): void }> = [];
  private child: ReturnType<typeof Bun.spawn>;

  constructor(readonly dir: string, private readonly deny: (line: Line) => boolean = () => false) {
    this.child = Bun.spawn(command, { cwd: dir, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    this.read();
  }

  private async read(): Promise<void> {
    for await (const text of linesOf(this.child.stdout as ReadableStream<Uint8Array>)) {
      let line: Line;
      try { line = JSON.parse(text); } catch { continue; }
      this.lines.push(line);
      if (isPermission(line)) this.answer(line);
      const met = this.waiting.filter((w) => w.test(line));
      this.waiting = this.waiting.filter((w) => !met.includes(w));
      for (const w of met) w.resolve(line);
    }
  }

  /** A request left unanswered holds the turn, so every one gets an answer. */
  private answer(line: Line): void {
    const response = this.deny(line)
      ? { behavior: "deny", message: "Denied by the protocol check. Do not try again." }
      : { behavior: "allow", updatedInput: line.request.input };
    this.write({ type: "control_response", response: { subtype: "success", request_id: line.request_id, response } });
  }

  write(message: unknown): void {
    const stdin = this.child.stdin as import("bun").FileSink;
    stdin.write(`${JSON.stringify(message)}\n`);
    stdin.flush();
  }

  say(text: string): void {
    this.write({ type: "user", message: { role: "user", content: text } });
  }

  /** The first line from now on that passes `test`, or null after `ms`. */
  next(test: (line: Line) => boolean, ms = RUN_TIMEOUT_MS): Promise<Line | null> {
    return new Promise((resolve) => {
      const waiter = { test, resolve };
      this.waiting.push(waiter);
      setTimeout(() => { this.waiting = this.waiting.filter((w) => w !== waiter); resolve(null); }, ms);
    });
  }

  /** Wait for `count` results, then for SETTLE_MS more in case another comes. */
  async results(count: number): Promise<Line[]> {
    const deadline = Date.now() + RUN_TIMEOUT_MS;
    while (this.lines.filter(isResult).length < count && Date.now() < deadline) {
      await this.next(isResult, deadline - Date.now());
    }
    await Bun.sleep(SETTLE_MS);
    return this.lines.filter(isResult);
  }

  stop(): void {
    try { this.child.kill(); } catch { /* already gone */ }
  }
}

const isResult = (line: Line) => line.type === "result";
const isEcho = (line: Line) => line.type === "user" && line.isReplay === true;
const isRequesting = (line: Line) => line.type === "system" && line.subtype === "status" && line.status === "requesting";
const isMessageStart = (line: Line) => line.type === "stream_event" && line.event?.type === "message_start";
const isTextDelta = (line: Line) => line.type === "stream_event" && line.event?.delta?.type === "text_delta";
const isToolUse = (line: Line) => line.type === "assistant" && (line.message?.content ?? []).some((part: Line) => part.type === "tool_use");
const isPermission = (line: Line) => line.type === "control_request" && line.request?.subtype === "can_use_tool";
const echoOf = (text: string) => (line: Line) => isEcho(line) && line.message?.content === text;

/** What one run found: the failure for each fact it checks, or null for a pass. */
type Findings = Partial<Record<number, string | null>>;

let version = "unknown";

async function inTemp<T>(body: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "protocol-check-"));
  try { return await body(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

/** Fact 5, on any process: the fields 16.2 and 16.6 name. */
function fields(lines: Line[]): string | null {
  const init = lines.find((line) => line.type === "system" && line.subtype === "init");
  if (init?.claude_code_version) version = init.claude_code_version;
  const missing: string[] = [];
  const compact = lines.find((line) => line.type === "autocompact_state");
  if (!compact) missing.push("no autocompact_state");
  else for (const key of ["effective_window", "threshold", "enabled"]) if (compact.value?.[key] === undefined) missing.push(`autocompact_state.value.${key}`);
  const limit = lines.find((line) => line.type === "rate_limit_event");
  if (!limit) missing.push("no rate_limit_event");
  else {
    const info = limit.rate_limit_info ?? {};
    if (typeof info.resetsAt !== "number") missing.push("rate_limit_info.resetsAt");
    for (const window of ["five_hour", "seven_day"]) {
      if (typeof info.unifiedWindows?.[window]?.utilization !== "number") missing.push(`unifiedWindows.${window}.utilization`);
    }
  }
  const result = lines.find(isResult);
  if (!result) missing.push("no result");
  else for (const key of ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
    if (typeof result.usage?.[key] !== "number") missing.push(`result.usage.${key}`);
  }
  return missing.length ? missing.join(", ") : null;
}

/** Facts 1 and 2: a message written while a tool call runs. */
async function duringTool(): Promise<Findings> {
  return inTemp(async (dir) => {
    const claude = new Claude(dir);
    const late = "Also end your answer with the word PELICAN.";
    try {
      claude.say("Run the shell command `sleep 5` with the Bash tool, once. Then say DONE in one line.");
      if (!(await claude.next(isToolUse))) return { 1: "no tool call", 2: "no tool call", 5: fields(claude.lines) };
      claude.say(late);
      const results = await claude.results(1);
      const one: string | null = results.length !== 1 ? `${results.length} results`
        : results[0].num_turns !== 2 ? `num_turns ${results[0].num_turns}`
        : null;
      const at = claude.lines.findIndex(echoOf(late));
      const after = claude.lines.slice(at + 1).find((line) => isRequesting(line) || isMessageStart(line));
      const two: string | null = at < 0 ? "no echo"
        : !after ? "nothing after the echo"
        : !isRequesting(after) ? "message_start before requesting"
        : null;
      return { 1: one, 2: two, 5: fields(claude.lines) };
    } finally { claude.stop(); }
  });
}

const LAST_TEXT = "Without using any tools, write about 250 words on how lighthouses work.";

/** Facts 3 and 4: one or two messages written while the agent writes its last text. */
async function duringText(texts: string[]): Promise<{ failure: string | null; fields: string | null }> {
  return inTemp(async (dir) => {
    const claude = new Claude(dir);
    try {
      claude.say(LAST_TEXT);
      if (!(await claude.next(isTextDelta))) return { failure: "no text", fields: fields(claude.lines) };
      for (const text of texts) claude.say(text);
      const results = await claude.results(2);
      const joined = texts.join("\n");
      const first = claude.lines.findIndex(isResult);
      const echo = claude.lines.findIndex(echoOf(joined));
      const failure = results.length !== 2 ? `${results.length} results`
        : echo < 0 ? `no echo of ${JSON.stringify(joined)}; echoes: ${JSON.stringify(claude.lines.filter(isEcho).map((line) => line.message?.content))}`
        : echo < first ? "the echo came before the first result"
        : null;
      return { failure, fields: fields(claude.lines) };
    } finally { claude.stop(); }
  });
}

/** Fact 6: a gated command reaches the bridge as a permission request. */
async function gated(): Promise<Findings> {
  return inTemp(async (dir) => {
    const git = (...words: string[]) => Bun.spawnSync(["git", ...words], { cwd: dir, stdout: "ignore", stderr: "ignore" });
    git("init", "-q", "--bare", "remote.git");
    git("init", "-q", "-b", "main", "work");
    const work = join(dir, "work");
    const inWork = (...words: string[]) => Bun.spawnSync(["git", ...words], { cwd: work, stdout: "ignore", stderr: "ignore" });
    inWork("-c", "user.name=check", "-c", "user.email=check@example.com", "commit", "-q", "--allow-empty", "-m", "start");
    inWork("remote", "add", "origin", join(dir, "remote.git"));
    const isPush = (line: Line) => isPermission(line) && line.request.tool_name === "Bash" && /git push .*--force|git push -f/.test(String(line.request.input?.command ?? ""));
    const claude = new Claude(work, isPush);
    try {
      claude.say("This is a scratch repository made for a test. Run exactly this command with the Bash tool, once: git push --force origin main");
      let request = await claude.next((line) => isPush(line) || isResult(line));
      // The agent may ask in words first, as the global instructions tell it to. That is the model, not the protocol.
      if (request && isResult(request)) {
        claude.say("Yes, I approve. Run it now.");
        request = await claude.next((line) => isPush(line) || isResult(line));
      }
      const six = !request || isResult(request)
        ? `no permission request; commands run: ${JSON.stringify(claude.lines.flatMap((line) => line.type === "assistant" ? line.message.content.filter((part: Line) => part.type === "tool_use").map((part: Line) => part.input?.command) : []))}; said: ${JSON.stringify(request?.result ?? "")}`
        : null;
      if (!six) await claude.results(claude.lines.filter(isResult).length + 1);
      return { 6: six, 5: fields(claude.lines) };
    } finally { claude.stop(); }
  });
}

const FACTS: Record<number, string> = {
  1: "message during a tool call joins the turn: one result, num_turns 2 (11.9.9)",
  2: "the echo comes before the requesting that carries it (11.9.9)",
  3: "message during the last text is a second turn with its own result (11.9.9)",
  4: "two messages during the last text: one second turn, one echo joined by a newline (11.9.9)",
  5: "autocompact_state, rate_limit_event and result usage carry their fields (16.2, 16.6)",
  6: "git push --force reaches the bridge as a stdio permission request (10.7)",
};
const tally: Record<number, { pass: number; total: number }> = Object.fromEntries(Object.keys(FACTS).map((n) => [n, { pass: 0, total: 0 }]));

function count(run: number, findings: Findings): void {
  for (const [key, failure] of Object.entries(findings)) {
    const fact = Number(key);
    tally[fact].total++;
    if (failure === null) tally[fact].pass++;
    else console.error(`  fact ${fact} run ${run}: ${failure}`);
  }
}

console.error(`${command[0]} on ${model}, ${runs} run${runs === 1 ? "" : "s"} of each fact`);
for (let run = 1; run <= runs; run++) {
  count(run, await duringTool());
  const one = await duringText(["Also end your answer with the word PELICAN."]);
  count(run, { 3: one.failure, 5: one.fields });
  const two = await duringText(["Also say PELICAN.", "And say HERON."]);
  count(run, { 4: two.failure, 5: two.fields });
  count(run, await gated());
  console.error(`run ${run} of ${runs} done`);
}

for (const [fact, text] of Object.entries(FACTS)) {
  const { pass, total } = tally[Number(fact)];
  console.log(`${fact}. ${pass}/${total}  ${text}  [claude ${version}, ${model}]`);
}
process.exit(Object.values(tally).every(({ pass, total }) => pass === total) ? 0 : 1);
