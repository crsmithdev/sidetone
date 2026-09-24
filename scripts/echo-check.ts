#!/usr/bin/env bun
/**
 * Whether the phone's echo canceller holds, on the phone, now (spec 18.13).
 *
 * The canceller is in the phone's audio hardware and in WebRTC, where no unit
 * test reaches, and the volume slider of 21 September broke it without a line
 * of the barge-in logic being wrong. So this asks the one thing that can tell:
 * the bridge says a passage into the room at its full level, and the record
 * shows whether the microphone brought any of it back.
 *
 *   bun scripts/echo-check.ts
 *
 * Run it on this machine, with the phone in the room, on its loudspeaker or in
 * the car, and nobody talking. Mute the bridge first ("sidetone, mute"), so an
 * echo, if there is one, does not become a turn. It exits 0 on a pass, 1 on an
 * echo and 2 when it cannot tell.
 */
import { loadConfig } from "../src/config.ts";
import { readDrive } from "../src/record.ts";
import { echoOf, verdict } from "../src/echo.ts";

/** About twenty seconds of speech, in sentences long enough for 18.10 to match. */
const PASSAGE = [
  "This is the echo check, and nobody needs to answer it.",
  "The bridge is talking to itself to find out whether the phone can hear it.",
  "If the microphone brings these words back, the echo canceller is not holding.",
  "A pass means the room stayed quiet while every one of these sentences played.",
];

/** How long the ear may still be finishing an utterance after the last sentence. */
const TAIL_MS = 4_000;
const WAIT_MS = 120_000;

const config = loadConfig();
const scheme = config.tlsCert && config.tlsKey ? "https" : "http";
const base = `${scheme}://127.0.0.1:${config.servePort}`;
// the bridge's certificate names the tailnet host, not the loopback
const tls = { rejectUnauthorized: false };

const health = await fetch(`${base}/health`, { tls } as RequestInit).then((r) => r.json()).catch(() => null) as
  { room: string; audio: string; microphone: string; soundMs: number | null; muted: boolean; network: { phone?: string } } | null;
if (!health) fail(2, `no bridge answers at ${base}`);
if (health.room !== "connected") fail(2, "the bridge has no room");
if (health.audio !== "on") fail(2, "the bridge's audio is off; say \"audio on\" or tap it on");
if (!health.network.phone) fail(2, "the phone is not in the room");
// 18.13.2 a cut microphone passes every check, because nothing can come back.
// On 23 September this happened: the phone cut its microphone a few seconds
// before the passage played, and the check said PASS.
if (health.microphone !== "open") fail(2, "the phone's microphone is cut; tap it open. A cut microphone passes every check");
if (!health.muted) console.log("the bridge is not muted: an echo will reach the agent as a turn");

const from = Date.now();
const said = await fetch(`${base}/say`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ text: PASSAGE.join(" ") }),
  tls,
} as RequestInit);
if (said.status !== 202) fail(2, `the bridge refused the passage: ${said.status} ${await said.text()}`);
console.log("saying the passage; stay quiet");

const last = PASSAGE.at(-1)!;
let endedAt = 0;
while (!endedAt) {
  if (Date.now() - from > WAIT_MS) fail(2, "the passage was not said in two minutes; is the bridge busy?");
  await Bun.sleep(500);
  const spoke = readDrive(config.recordPath, from)?.events.find((e) => e.kind === "spoke" && echoOf(last, [e.text]) !== null);
  if (spoke) endedAt = spoke.at;
}
await Bun.sleep(TAIL_MS);

// the microphone may have been cut part way through, which reads as a quiet room
const after = await fetch(`${base}/health`, { tls } as RequestInit).then((r) => r.json()).catch(() => null) as
  { microphone?: string; soundMs?: number | null } | null;
if (after?.microphone !== "open") fail(2, "the phone cut its microphone while the passage played");
// 18.13.3 an open track that carries nothing brings nothing back either. On
// 23 September a check passed while the microphone had been dead for 39 s.
const soundMs = after.soundMs;
if (soundMs === null || soundMs === undefined || soundMs > TAIL_MS) {
  fail(2, `the microphone carried no sound for the last ${soundMs === null || soundMs === undefined ? "of it" : `${Math.round(soundMs / 1000)}s`}; the capture is dead, not the room quiet`);
}

const events = readDrive(config.recordPath, from)?.events ?? [];
const result = verdict(events, PASSAGE, endedAt + TAIL_MS);
console.log(result.lines.join("\n"));
console.log(result.word);
process.exit(result.code);

function fail(code: number, why: string): never {
  console.log(why);
  process.exit(code);
}
