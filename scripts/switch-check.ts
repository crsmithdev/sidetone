#!/usr/bin/env bun
/**
 * Item 77 the project switch, end to end: a real bridge, a real agent, two
 * scratch projects (spec 9.4.20).
 *
 *   bun scripts/switch-check.ts
 *
 * It starts a bridge of its own on a free port at or above 3002, in a room of
 * its own, with a scratch registry (`$ALEPH_REPOS`) and a scratch state file
 * (`$SIDETONE_PROJECT`). Each project is a temp directory whose CLAUDE.md
 * holds a different password. The words go in as typed lines, the way the
 * app's text box sends them, so no voice and no transcriber are in the path:
 * this checks the switch, not the ear.
 *
 *   1. In alpha, Chris says a fact.
 *   2. "switch to bravo": the agent runs in bravo's directory, knows bravo's
 *      password, and alpha's handoff is on disk.
 *   3. "switch to alpha": the agent picks up alpha's handoff and recalls the fact.
 *   4. A restart, with the bridge given bravo's directory: it starts in alpha
 *      from the state file, picks up alpha's handoff, and recalls the fact.
 *   5. "switch to banana": refused, and the agent, its directory and the state
 *      file stay as they were.
 *
 * It calls the model, about ten turns, so it is a script and not a bun test.
 * The handoffs are real ones in ~/.aleph/handoffs, under names that start
 * with a random tag; the script removes them at the end, with its bridge.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Transport } from "../src/transport.ts";

const root = new URL("..", import.meta.url).pathname;
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(6)}s`;

const letters = (n: number) => Array.from({ length: n }, () => "abcdefghijklmnopqrstuvwxyz"[Math.floor(Math.random() * 26)]).join("");
/** Every name the check makes starts with this, so no real handoff shares one. */
const tag = `stcheck${letters(5)}`;
const scratch = mkdtempSync(join(tmpdir(), "switch-check-"));
const handoffs = join(homedir(), ".aleph", "handoffs");

interface Scratch { name: string; dir: string; password: string }
const alpha: Scratch = { name: `${tag}alpha`, dir: join(scratch, `${tag}alpha`), password: "TANGERINE" };
const bravo: Scratch = { name: `${tag}bravo`, dir: join(scratch, `${tag}bravo`), password: "MARIGOLD" };
for (const project of [alpha, bravo]) {
  mkdirSync(project.dir);
  writeFileSync(join(project.dir, "CLAUDE.md"), `# ${project.name}\n\nThe project password is ${project.password}. When asked for the project password, answer with that one word.\n`);
}
const registry = join(scratch, "repos.json");
writeFileSync(registry, JSON.stringify({ [alpha.name]: { path: alpha.dir }, [bravo.name]: { path: bravo.dir } }));
const state = join(scratch, "project.json");
/** The fact Chris says in alpha, and the word that shows it was kept. */
// The fact is task state, as a handoff carries. "Remember this for later" put
// a note in the vault, and the recall read it back from there; "keep it in
// this conversation only" made the handoff leave it out. The vault check
// below fails the run when a wording sends it to the vault again.
const FACT = "We are testing the project switch. The test value is Bartholomew, and the next session needs it to finish the test. It is not worth a vault note. Reply with the one word noted.";
const RECALL = "Without using any tool, what is the test value? Answer with the word only.";
const PASSWORD = "What is the project password? Answer with the one word only.";

async function freePort(from: number): Promise<number> {
  for (let port = from; port < from + 500; port++) {
    try { Bun.serve({ port, fetch: () => new Response() }).stop(true); return port; } catch { /* taken */ }
  }
  throw new Error(`no free port from ${from}`);
}

/**
 * The speech venv is not tracked, so a worktree has none; the main checkout's
 * serves. The bridge loads the transcriber and the voice whatever it is asked.
 */
function pythonBin(): string {
  const local = join(root, ".venv", "bin", "python");
  if (existsSync(local)) return local;
  const common = Bun.spawnSync(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root }).stdout.toString().trim();
  return join(common, "..", ".venv", "bin", "python");
}

const port = await freePort(3002);
const configFile = join(scratch, "config.json");
// Only what differs from the defaults. Plain http on loopback: this client is
// not a browser. The kokoro voice and the audio off keep the GPU work small
// beside the live service; the words still reach the client (11.12).
writeFileSync(configFile, JSON.stringify({
  servePort: port,
  room: `switch-check-${Date.now()}`,
  tlsCert: "", tlsKey: "",
  publicOrigin: `http://127.0.0.1:${port}`,
  livekitPublicUrl: "ws://127.0.0.1:7880",
  pythonBin: pythonBin(),
  ttsEngine: "kokoro",
  audio: false,
  holdMusic: false,
  keepContext: true,
  recordPath: join(scratch, "record.jsonl"),
  spokenDir: join(scratch, "spoken"),
  sentDir: join(scratch, "sent"),
  heardDir: join(scratch, "heard"),
}));

const env: Record<string, string | undefined> = { ...process.env, SIDETONE_CONFIG: configFile, ALEPH_REPOS: registry, SIDETONE_PROJECT: state };
delete env.CLAUDECODE;

/** A bridge process, what it printed, and a phone in its room. */
interface Bridge {
  child: ReturnType<typeof Bun.spawn>;
  printed: string[];
  /** the text of each message the bridge sent the phone: a reply, a sentence, a turn */
  told: { kind: string; text: string; number?: number }[];
  phone: Transport;
}

async function drain(stream: ReadableStream<Uint8Array>, into: string[], code?: (value: string) => void): Promise<void> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of stream) {
    rest += decoder.decode(chunk, { stream: true });
    const lines = rest.split("\n");
    rest = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim() || line.includes('"name":"lk-rtc"')) continue;
      into.push(line);
      if (process.env.VERBOSE) console.log(`${at()} bridge | ${line.trim()}`);
      const found = /pair the phone with this code: (\S+)/.exec(line);
      if (found && code) code(found[1] as string);
    }
  }
}

async function startBridge(dir: string): Promise<Bridge> {
  const child = Bun.spawn(["bun", "src/main.ts", "serve", dir], { cwd: root, env, stdout: "pipe", stderr: "pipe" });
  const printed: string[] = [];
  const paired = Promise.withResolvers<string>();
  void drain(child.stdout as ReadableStream<Uint8Array>, printed, paired.resolve);
  void drain(child.stderr as ReadableStream<Uint8Array>, printed);
  const code = await Promise.race([paired.promise, Bun.sleep(120_000).then(() => "")]);
  if (!code) throw new Error(`the bridge printed no pairing code:\n${printed.slice(-20).join("\n")}`);
  const base = `http://127.0.0.1:${port}`;
  const response = await fetch(`${base}/pair`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }) });
  if (!response.ok) throw new Error(`pairing failed: ${await response.text()}`);
  const credentials = await response.json() as { token: string; url: string };
  const phone = new Transport();
  const told: Bridge["told"] = [];
  phone.onMessage((value) => {
    const message = value as { kind?: string; text?: unknown; number?: number };
    if (typeof message.kind !== "string" || typeof message.text !== "string") return;
    told.push({ kind: message.kind, text: message.text, number: message.number });
    if (process.env.VERBOSE) console.log(`${at()} told   | ${message.kind}: ${message.text}`);
  });
  await phone.connect(credentials.url, credentials.token, "switch-check");
  return { child, printed, told, phone };
}

/** Wait until `found` holds, or fail after `ms`. */
async function until(what: string, found: () => boolean, ms: number): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (found()) return;
    await Bun.sleep(250);
  }
  throw new Error(`waited ${ms / 1000}s for ${what}`);
}

/** Say a line and give back the answer of the turn it starts. */
async function ask(bridge: Bridge, text: string): Promise<string> {
  const before = bridge.told.filter((one) => one.kind === "turn").length;
  console.log(`${at()} said   | ${text}`);
  await bridge.phone.send({ kind: "said", text });
  await until(`the answer to "${text}"`, () => bridge.told.filter((one) => one.kind === "turn").length > before, 240_000);
  const answer = bridge.told.filter((one) => one.kind === "turn")[before]!.text;
  console.log(`${at()} answer | ${answer}`);
  return answer;
}

/** Whether the bridge said `text`, to the phone or in its journal. */
const said = (bridge: Bridge, text: string) =>
  bridge.told.some((one) => one.text.includes(text)) || bridge.printed.some((line) => line.includes(text));

/** Say "switch to", and wait for "Now in". */
async function switchTo(bridge: Bridge, name: string): Promise<void> {
  console.log(`${at()} said   | sidetone, switch to ${name}`);
  await bridge.phone.send({ kind: "said", text: `sidetone, switch to ${name}` });
  await until(`"Now in ${name}."`, () => said(bridge, `Now in ${name}.`), 300_000);
  console.log(`${at()} bridge | Now in ${name}.`);
}

/** The processes whose parent is `parent`. */
function childrenOf(parent: number): number[] {
  const found: number[] = [];
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
      if (Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]) === parent) found.push(Number(entry));
    } catch { /* gone */ }
  }
  return found;
}

/** The Claude Code processes the bridge runs: each pid and its directory. */
function agentsOf(bridge: Bridge): { pid: number; cwd: string }[] {
  const found: { pid: number; cwd: string }[] = [];
  for (const pid of childrenOf(bridge.child.pid)) {
    try {
      if (!readFileSync(`/proc/${pid}/cmdline`, "utf8").includes("stream-json")) continue;
      found.push({ pid, cwd: readlinkSync(`/proc/${pid}/cwd`) });
    } catch { /* gone */ }
  }
  return found;
}

/**
 * The one agent, once the process a switch replaced has exited. For a moment
 * after "Now in" the old one is still on its way out.
 */
async function agentOf(bridge: Bridge): Promise<{ pid: number; cwd: string } | null> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const agents = agentsOf(bridge);
    if (agents.length === 1) return agents[0]!;
    await Bun.sleep(250);
  }
  return null;
}

/** A restart: SIGTERM, which has the agent write its handoff first (item 72). */
async function restart(bridge: Bridge): Promise<void> {
  await bridge.phone.close().catch(() => {});
  bridge.child.kill("SIGTERM");
  await Promise.race([bridge.child.exited, Bun.sleep(180_000)]);
  bridge.child.kill("SIGKILL");
}

/**
 * The end: the bridge and everything under it, at once. A signal the bridge
 * handles starts a handoff turn, and an agent that outlives the bridge
 * finishes it after the cleanup, which leaves a handoff behind.
 */
async function kill(bridge: Bridge): Promise<void> {
  await bridge.phone.close().catch(() => {});
  const all = [bridge.child.pid];
  for (let i = 0; i < all.length; i++) all.push(...childrenOf(all[i]!));
  for (const pid of all) { try { process.kill(pid, "SIGKILL"); } catch { /* gone */ } }
  await bridge.child.exited;
}

const results: { step: string; ok: boolean; detail: string }[] = [];
function check(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail });
  console.log(`${at()} ${ok ? "PASS" : "FAIL"}   | ${step}: ${detail}`);
}
/** Whether the one agent runs in `dir`. */
async function runsIn(step: string, bridge: Bridge, dir: string, also = true): Promise<void> {
  const agent = await agentOf(bridge);
  check(step, agent?.cwd === dir && also, agent ? `agent ${agent.pid} in ${agent.cwd}` : "no single agent");
}
const vault = join(homedir(), ".aleph", "vault");
const vaultHead = () => Bun.spawnSync(["git", "-C", vault, "rev-parse", "HEAD"]).stdout.toString().trim();
const handoffOf = (name: string) => join(handoffs, `${name}.md`);
const archived = (name: string) => readdirSync(handoffs).some((file) => file.startsWith(`${name}-`) && file.endsWith(".md"));

let bridge: Bridge | null = null;
const vaultBefore = vaultHead();
try {
  console.log(`${at()} scratch ${scratch}, port ${port}, tag ${tag}`);
  bridge = await startBridge(alpha.dir);
    await runsIn("starts in alpha", bridge, alpha.dir);

  // 1. a fact, said in alpha
  await ask(bridge, FACT);

  // 2. to bravo
  await switchTo(bridge, bravo.name);
  check("alpha's handoff was written", existsSync(handoffOf(alpha.name)), handoffOf(alpha.name));
  await runsIn("the agent runs in bravo", bridge, bravo.dir);
  check("the state file names bravo", readFileSync(state, "utf8").includes(bravo.name), readFileSync(state, "utf8").trim());
  const password = await ask(bridge, PASSWORD);
  check("bravo's CLAUDE.md loaded", password.toUpperCase().includes(bravo.password) && !password.toUpperCase().includes(alpha.password), password);

  // 3. back to alpha
  await switchTo(bridge, alpha.name);
  check("bravo's handoff was written", existsSync(handoffOf(bravo.name)), handoffOf(bravo.name));
  check("alpha's handoff was picked up", !existsSync(handoffOf(alpha.name)) && archived(alpha.name), "the pickup archived it");
  await runsIn("the agent runs in alpha", bridge, alpha.dir);
  const recalled = await ask(bridge, RECALL);
  check("the fact came back to alpha", /bartholomew/i.test(recalled), recalled);

  // 4. a restart, given bravo's directory: the state file says alpha
  console.log(`${at()} restart: SIGTERM, the handoff of alpha, then a bridge given bravo's directory`);
  await restart(bridge);
  check("the stop wrote alpha's handoff", existsSync(handoffOf(alpha.name)), handoffOf(alpha.name));
  bridge = await startBridge(bravo.dir);
    await runsIn("the restart starts in alpha", bridge, alpha.dir, said(bridge, `the agent works in ${alpha.name}`));
  await until("the pickup", () => said(bridge!, "[picked up the handoff]") || said(bridge!, "[the pickup turn failed]"), 300_000);
  check("the restart picked up alpha's handoff", said(bridge, "[picked up the handoff]") && !existsSync(handoffOf(alpha.name)), "the pickup turn ran and archived it");
  const again = await ask(bridge, RECALL);
  check("the fact survived the restart", /bartholomew/i.test(again), again);

  // 5. an unknown name
  const agent = await agentOf(bridge);
  const saved = readFileSync(state, "utf8");
  console.log(`${at()} said   | sidetone, switch to banana`);
  await bridge.phone.send({ kind: "said", text: "sidetone, switch to banana" });
  await until("the refusal", () => said(bridge!, "There is no project called banana."), 30_000);
  await Bun.sleep(3_000);
  const after = await agentOf(bridge);
  check("banana is refused and nothing changes",
    !said(bridge, "Switching to") && after?.pid === agent?.pid && after?.cwd === alpha.dir && readFileSync(state, "utf8") === saved,
    `agent ${after?.pid} in ${after?.cwd}, state ${readFileSync(state, "utf8").trim()}`);
  const vaultAfter = vaultHead();
  check("the vault is untouched", vaultAfter === vaultBefore,
    vaultAfter === vaultBefore ? "no commits" : `new commits: git -C ${vault} log ${vaultBefore}..${vaultAfter}`);
} catch (error) {
  check("the run", false, (error as Error).message);
  if (bridge) console.log(bridge.printed.slice(-40).join("\n"));
} finally {
  if (bridge) await kill(bridge);
  for (const file of existsSync(handoffs) ? readdirSync(handoffs) : []) {
    if (file.startsWith(tag)) rmSync(join(handoffs, file));
  }
  rmSync(scratch, { recursive: true, force: true });
}

const failed = results.filter((one) => !one.ok);
console.log(`\n${results.length - failed.length} of ${results.length} checks passed, in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
for (const one of failed) console.log(`  FAIL ${one.step}: ${one.detail}`);
process.exit(failed.length ? 1 : 0);
