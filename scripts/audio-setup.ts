#!/usr/bin/env bun
/**
 * The phone's audio setup, read or changed from here, with no build (spec 18.15).
 *
 * On 23 September one boolean, the echo canceller, cost three app builds and
 * two hours. The setup now changes from the bridge: the phone stores the one
 * pushed, rejoins the room with it, and says which one it runs with in its
 * `device` message (14.15), so the record always names what ran.
 *
 *   bun scripts/audio-setup.ts
 *       the setup the phone last reported, from the record
 *   bun scripts/audio-setup.ts --mode normal --output media --focus none --canceller software
 *       push one; add --noise-suppression off or --auto-gain-control off, which are on unless said
 *   bun scripts/audio-setup.ts --default
 *       send the phone back to the setup in its code
 *
 * A push waits for the phone to rejoin and report, and exits 1 when it does
 * not, or reports another setup. It refuses when no phone is in the room.
 * A pushed setup is an experiment: `Audio.checked` in the app still holds
 * the setup in the code (18.13.1), which is what ships. Run
 * `bun scripts/echo-check.ts` with the pushed setup before trusting it.
 */
import { loadConfig } from "../src/config.ts";
import type { Device } from "../src/diagnostics.ts";
import type { Setup } from "../src/messages.ts";
import { readDrive } from "../src/record.ts";
import { namesWords, readSetup } from "../src/setup.ts";

/** How long the phone gets to leave the room, join it again and say what it is. */
const REPORT_MS = 45_000;

const config = loadConfig();
const scheme = config.tlsCert && config.tlsKey ? "https" : "http";
const base = `${scheme}://127.0.0.1:${config.servePort}`;
// the bridge's certificate names the tailnet host, not the loopback
const tls = { rejectUnauthorized: false };

const args = process.argv.slice(2);
if (args.length === 0) {
  const last = lastDevice(0);
  if (!last) fail(1, "the record holds no device message from the phone");
  console.log(reported(last));
  process.exit(0);
}

const setup = fromArgs(args);
if (!setup) fail(2, "usage: audio-setup.ts [--mode call|normal --output voice|media --focus gain|none --canceller hardware|software [--noise-suppression on|off] [--auto-gain-control on|off] | --default]");

const health = await fetch(`${base}/health`, { tls } as RequestInit).then((r) => r.json()).catch(() => null) as
  { room: string; network: { phone?: string } } | null;
if (!health) fail(2, `no bridge answers at ${base}`);
if (health.room !== "connected") fail(2, "the bridge has no room");
if (!health.network.phone || health.network.phone === "lost") fail(2, "the phone is not in the room");

const from = Date.now();
const pushed = await fetch(`${base}/setup`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(setup),
  tls,
} as RequestInit);
if (pushed.status !== 202) fail(2, `the bridge refused the setup: ${pushed.status} ${await pushed.text()}`);
console.log(`pushed ${setup.default ? "the setup in the app's code" : namesWords(setup)}; waiting for the phone to rejoin and report`);

let device: Device | null = null;
while (!device) {
  if (Date.now() - from > REPORT_MS) fail(1, `the phone did not report in ${REPORT_MS / 1000}s: it is not in the room, or its app is from before the setup message`);
  await Bun.sleep(1_000);
  device = lastDevice(from);
}
console.log(reported(device));
if (!device.setup) fail(1, "the phone names no setup: its app is from before the setup message");
const asked = setup.default ? !device.pushed : device.pushed && namesWords(device.setup) === namesWords(setup);
if (!asked) fail(1, "the phone reports another setup than the one pushed");
console.log("the phone runs with the setup pushed");
process.exit(0);

/** The setup the phone last reported, from the record, at or after `since`. */
function lastDevice(since: number): Device | null {
  const events = readDrive(config.recordPath, since)?.events ?? [];
  return events.filter((e): e is Device => e.kind === "device").at(-1) ?? null;
}

function reported(device: Device): string {
  const when = new Date(device.at).toISOString();
  if (!device.setup) return `${when}: the phone (${device.model}) named no setup; its app is from before the setup message`;
  return `${when}: the phone (${device.model}) runs with ${namesWords(device.setup)}: ${device.pushed ? "pushed" : "the setup in the code"}; ${device.canceller} canceller running, route ${device.route}`;
}

/** The setup the flags ask for, or null when they do not make one. */
function fromArgs(given: string[]): Setup | null {
  if (given.length === 1 && given[0] === "--default") return { kind: "setup", default: true };
  const values: Record<string, unknown> = { noiseSuppression: true, autoGainControl: true };
  const names: Record<string, string> = { "--mode": "mode", "--output": "output", "--focus": "focus", "--canceller": "canceller", "--noise-suppression": "noiseSuppression", "--auto-gain-control": "autoGainControl" };
  for (let i = 0; i < given.length; i += 2) {
    const name = names[given[i] ?? ""];
    const value = given[i + 1];
    if (!name || value === undefined) return null;
    values[name] = name === "noiseSuppression" || name === "autoGainControl" ? value === "on" || (value === "off" ? false : value) : value;
  }
  return readSetup(values);
}

function fail(code: number, why: string): never {
  console.log(why);
  process.exit(code);
}
