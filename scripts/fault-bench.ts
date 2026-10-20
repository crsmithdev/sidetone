#!/usr/bin/env bun
/**
 * What the supervisor does with a fault (spec section 8), measured on the real
 * `claude` and the real `Session`, not on the scripted process of the tests.
 *
 *   bun scripts/fault-bench.ts                      every scenario
 *   bun scripts/fault-bench.ts --only kill-reply,hang-reply
 *   bun scripts/fault-bench.ts --out ~/.sidetone/faults/2026-10-20
 *
 * Each scenario starts a session in a directory of its own and teaches it a
 * word. Then it injects one fault into the process by its pid and waits for
 * the supervisor. Then it asks for the word, in a turn of its own:
 *
 * - detected: the fault to `onRestart`, and the reason the supervisor gave.
 * - back: the fault to the end of the first turn that answered after it.
 * - context: whether that turn knew the word.
 * - leftover: whether the old process still existed 5 s after the restart.
 * - actions: for `kill-after-action`, the lines in `marker.txt`. One is right;
 *   two is an action done twice.
 *
 * A compaction loop cannot be caused in a real process, so test/supervisor.test.ts
 * is all that covers it. The settings are the live ones, so a scenario that
 * waits for the ceiling takes more than ten minutes.
 *
 * It costs money and needs the network, so it is not part of `bun test`.
 */
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, type Config } from "../src/config.ts";
import { ASK_RULES } from "../src/gated.ts";
import { Session } from "../src/session.ts";

const WORD = "marigold";
const TEACH = `Remember the word ${WORD}. Reply with one short sentence.`;
const RECALL = "What word did I ask you to remember? Answer with the word alone, or say you do not know.";
const COUNT = "Count from one to sixty in words, one number per line, and nothing else.";
/** The longest a scenario waits for the supervisor: the ceiling ladder and some. */
const WAIT_MS = 15 * 60_000;

type Fault = "SIGKILL" | "SIGSTOP";
interface Scenario {
  name: string;
  /** what the faulted turn asks; empty for a fault between turns */
  prompt: string;
  fault: Fault;
  /** when the fault goes in */
  when: "reply" | "tool" | "afterTool" | "idle" | "none";
  settings?: Partial<Config>;
}

const SCENARIOS: Scenario[] = [
  // no fault: whether the word comes back at all, so a lost word after a fault means something
  { name: "control", prompt: "", fault: "SIGKILL", when: "none" },
  { name: "kill-reply", prompt: COUNT, fault: "SIGKILL", when: "reply" },
  { name: "hang-reply", prompt: COUNT, fault: "SIGSTOP", when: "reply" },
  { name: "kill-idle", prompt: "", fault: "SIGKILL", when: "idle" },
  // the voice instruction sends work over fifteen seconds to the background, and a tool
  // that returns at once leaves nothing in flight, so this one asks for the foreground
  {
    name: "kill-tool",
    // Claude Code blocks a plain `sleep` of this length in the foreground
    prompt: "Use Bash to run `python3 -c 'import time; time.sleep(110)'` in the foreground, not in the background, and wait for it. Then say done.",
    fault: "SIGKILL", when: "tool",
  },
  {
    name: "kill-after-action",
    prompt: `Use Bash to run \`echo run >> marker.txt\`. Then ${COUNT.toLowerCase()}`,
    fault: "SIGKILL", when: "afterTool",
  },
  // 8.7 no leak to wait for, so the limit goes under the size of a healthy process
  { name: "memory-recycle", prompt: "", fault: "SIGKILL", when: "none", settings: { memoryRecycleBytes: 64 * 1024 ** 2 } },
];

const args = process.argv.slice(2);
const option = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const only = option("--only")?.split(",");
const out = option("--out") ?? join(homedir(), ".sidetone", "faults", new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-"));

const config = loadConfig();
const claudeArgs = [
  ...config.claudeArgs,
  "--append-system-prompt", config.voiceInstruction,
  "--permission-prompt-tool", "stdio",
  "--settings", JSON.stringify({ permissions: { ask: ASK_RULES } }),
];

/** The newest `claude` this script started: the session's process. */
async function agentPid(): Promise<number | null> {
  const text = await new Response(Bun.spawn(["pgrep", "-n", "-P", String(process.pid)]).stdout).text();
  const pid = Number(text.trim());
  return pid > 0 ? pid : null;
}

const exists = (pid: number) => existsSync(`/proc/${pid}`) && !/^State:\s+Z/m.test(readFileSync(`/proc/${pid}/status`, "utf8"));

interface Result {
  name: string; fault: string;
  faultedTurn: string;
  detectedMs: number | null; reason: string;
  backMs: number | null; context: boolean | null;
  leftover: boolean | null; actions: number | null;
  checkpoint: boolean;
}

async function run(scenario: Scenario): Promise<Result> {
  const dir = mkdtempSync(join(tmpdir(), `fault-${scenario.name}-`));
  const log = (line: string) => console.log(`${scenario.name} | ${line}`);
  const restarted = Promise.withResolvers<{ at: number; reason: string }>();
  let firstDeltaAt = 0;
  let toolEndedAt = 0;
  let checkpoint = false;
  const trigger = Promise.withResolvers<void>();

  const session = new Session(dir, { ...config, claudeArgs, ...scenario.settings }, {
    onRestart: (reason) => { log(`restart: ${reason}`); restarted.resolve({ at: Date.now(), reason }); },
    onCheckpoint: (ms) => { checkpoint = true; log(`checkpoint at ${(ms / 1000).toFixed(0)}s; no agreement word`); },
    onInterrupt: (reason) => log(`interrupt: ${reason}`),
    onPermission: (request) => { log(`allowed ${request.tool}`); session.answer(request.id, true); },
    onEvent: (event) => {
      if (event.kind === "delta" && !firstDeltaAt) {
        firstDeltaAt = Date.now();
        if (scenario.when === "reply") setTimeout(() => trigger.resolve(), 1_000);
      }
      if (event.kind === "delta" && toolEndedAt && scenario.when === "afterTool") trigger.resolve();
      if (event.kind === "toolStart") log(`tool started: ${event.tool}`);
      if (event.kind === "toolStart" && scenario.when === "tool") setTimeout(() => trigger.resolve(), 2_000);
      if (event.kind === "toolEnd") { toolEndedAt = Date.now(); log("tool ended"); }
    },
  });

  await session.ask(TEACH);
  log("taught the word");
  const pid = await agentPid();
  if (!pid) throw new Error("no agent process");

  let faultAt = 0;
  let faultedTurn = "none";
  const inject = () => { faultAt = Date.now(); process.kill(pid, scenario.fault); log(`${scenario.fault} to ${pid}`); };

  if (scenario.when === "idle") {
    inject();
  } else if (scenario.when !== "none") {
    firstDeltaAt = 0;
    const turn = session.ask(scenario.prompt).then(
      (t) => `answered: ${t.text.slice(0, 40).replace(/\n/g, " ")}`,
      (error: Error) => `failed: ${error.message}`,
    );
    await trigger.promise;
    inject();
    faultedTurn = await Promise.race([turn, Bun.sleep(WAIT_MS).then(() => "still running")]);
    log(`the faulted turn ${faultedTurn}`);
  } else {
    // memory-recycle: the turn that taught the word has ended; the next tick is over the limit
    faultAt = Date.now();
  }
  if (scenario.name === "control") restarted.resolve({ at: faultAt, reason: "none (control)" });

  // kill-idle: nothing notices a dead process between turns, so the next turn is what finds it
  const recall = scenario.when === "idle" ? session.ask(RECALL).then((t) => t, () => null) : null;
  const restart = await Promise.race([restarted.promise, Bun.sleep(WAIT_MS).then(() => null)]);
  // a SIGTERM takes a moment to land, so the old process gets that moment, beside the recall
  // the control's process is the live one, and the recall needs it
  const leftoverCheck = scenario.name === "control" ? Promise.resolve(null) : (restart ? Bun.sleep(5_000) : Promise.resolve()).then(() => {
    const left = restart ? exists(pid) : null;
    if (exists(pid)) { process.kill(pid, "SIGKILL"); log(`killed the leftover ${pid}`); }
    return left;
  });

  let back: Awaited<ReturnType<Session["ask"]>> | null = recall ? await recall : null;
  if (!back) back = await session.ask(RECALL).then((t) => t, () => null);
  const backAt = Date.now();
  log(`the recall turn ${back ? `answered: ${back.text.slice(0, 60).replace(/\n/g, " ")}` : "failed"}`);
  const leftover = await leftoverCheck;
  session.stop();

  const marker = join(dir, "marker.txt");
  const actions = scenario.name === "kill-after-action" ? (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0) : null;
  const result: Result = {
    name: scenario.name, fault: scenario.fault, faultedTurn,
    detectedMs: restart ? restart.at - faultAt : null, reason: restart?.reason ?? "none",
    backMs: back ? backAt - faultAt : null,
    context: back ? back.text.toLowerCase().includes(WORD) : null,
    leftover, actions, checkpoint,
  };
  log(JSON.stringify(result));
  return result;
}

const results: Result[] = [];
for (const scenario of SCENARIOS.filter((s) => !only || only.includes(s.name))) {
  results.push(await run(scenario));
}
await Bun.write(join(out, "results.json"), JSON.stringify(results, null, 2));

const s = (ms: number | null) => ms === null ? "-" : (ms / 1000).toFixed(1);
console.log(`\n${out}\n`);
console.log("| scenario | fault | detected s | reason | back s | context kept | leftover process | actions | checkpoint |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const r of results) {
  console.log(`| ${r.name} | ${r.fault} | ${s(r.detectedMs)} | ${r.reason} | ${s(r.backMs)} | ${r.context ?? "-"} | ${r.leftover ?? "-"} | ${r.actions ?? "-"} | ${r.checkpoint} |`);
}
process.exit(0);
