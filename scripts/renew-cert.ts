#!/usr/bin/env bun
/**
 * Renew the tailnet certificate, and only disturb anything if it changed.
 *
 * The phone refuses the microphone over a certificate it does not trust, and
 * that arrives as silence rather than as an error, so the renewal has to
 * happen well before expiry and the terminator has to be told. Caddy reads the
 * pem once at start and serves the old one forever otherwise.
 *
 * What this adds over calling `main.ts cert` from the unit is the comparison.
 * The timer runs weekly; the certificate changes about every three months. The
 * other fifty-one restarts cut off whatever was being said for no reason.
 */
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { fetchCert } from "../src/keys.ts";

const dir = join(homedir(), ".voice-bridge");
const certPath = join(dir, "tls-cert.pem");

async function fingerprint(): Promise<string> {
  const file = Bun.file(certPath);
  if (!await file.exists()) return "";
  return createHash("sha256").update(await file.bytes()).digest("hex").slice(0, 16);
}

async function run(what: string, args: string[]): Promise<void> {
  const done = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const code = await done.exited;
  console.log(code === 0 ? `  ${what}: done` : `  ${what}: FAILED, ${(await new Response(done.stderr).text()).trim()}`);
}

const before = await fingerprint();
const result = fetchCert(certPath, join(dir, "tls-key.pem"));
console.log(result.message);
if (!result.ok) process.exit(1);

const after = await fingerprint();
if (before === after) {
  console.log(`certificate unchanged (${after}); nothing restarted`);
  process.exit(0);
}

console.log(`certificate changed: ${before || "none"} -> ${after}`);
// the terminator reads the pem at start, and the bridge holds a room that the
// terminator's restart drops, so both have to come back
await run("lk-tls", ["docker", "restart", "lk-tls"]);
await run("voice-bridge", ["systemctl", "--user", "restart", "voice-bridge.service"]);
