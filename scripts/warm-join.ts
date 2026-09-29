#!/usr/bin/env bun
/**
 * Drive test 13 at the desk: a phone that arrives while the engines warm.
 *
 * A restart of the bridge leaves the phone paired and LiveKit up, so the app
 * can be back in the room seconds before whisper is warm. The room used to be
 * joined before the engines were ready and the handlers attached after both,
 * so a phone in that window got no protocol and no history, and its
 * microphone cut was dropped. `test/drive.test.ts` checks the channel before
 * the engines are warm; only the real process shows the order in serve.ts.
 *
 *   bun scripts/warm-join.ts
 *
 * It starts a bridge of its own on a free port, in a room of its own, and
 * pairs with it. Then it stops that bridge, starts it again with the same
 * room, and joins at once with the token it kept, as the app does. It sends
 * a microphone cut and an open while the engines warm, and checks each of the
 * card's pass conditions against the moment the new bridge is warm. It needs
 * the LiveKit server on 7880 and the speech engines of the config. It exits 0
 * when every check passes and 1 when one fails.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../src/config.ts";
import { Transport } from "../src/transport.ts";

const scratch = mkdtempSync(join(tmpdir(), "warm-join-"));
const port = 3200 + Math.floor(Math.random() * 300);
const path = join(scratch, "config.json");
await Bun.write(path, JSON.stringify({
  ...loadConfig(),
  servePort: port,
  room: `warm-join-${Date.now()}`,
  // plain http on loopback, as scripts/fake-phone.ts does
  tlsCert: "", tlsKey: "",
  publicOrigin: `http://127.0.0.1:${port}`,
  livekitPublicUrl: "ws://127.0.0.1:7880",
}));

const t0 = Date.now();
const at = () => Date.now() - t0;

/** A bridge process, and the time of each line it printed. */
function start(label: string) {
  const child = Bun.spawn(["bun", "src/main.ts", "serve", "/tmp"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { ...process.env, SIDETONE_CONFIG: path },
    stdout: "pipe", stderr: "pipe",
  });
  const lines: Array<{ at: number; line: string }> = [];
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    let rest = "";
    for await (const chunk of stream) {
      rest += decoder.decode(chunk, { stream: true });
      const split = rest.split("\n");
      rest = split.pop() ?? "";
      for (const line of split) {
        if (!line.trim() || line.includes('"name":"lk-rtc"')) continue;
        lines.push({ at: at(), line: line.trim() });
        if (process.env.VERBOSE) console.log(`${String(at()).padStart(6)} ${label} | ${line.trim()}`);
      }
    }
  };
  void drain(child.stdout as ReadableStream<Uint8Array>);
  void drain(child.stderr as ReadableStream<Uint8Array>);
  const first = async (pattern: RegExp, ms = 120_000) => {
    const stop = Date.now() + ms;
    while (Date.now() < stop) {
      const found = lines.find((entry) => pattern.test(entry.line));
      if (found) return found;
      await Bun.sleep(20);
    }
    return null;
  };
  return { child, lines, first };
}

// 1. The first bridge, and the pairing the app keeps.
const a = start("first");
const code = (await a.first(/pair the phone with this code: (\S+)/))?.line.match(/code: (\S+)/)?.[1];
if (!code) { console.error("the first bridge never printed a pairing code"); a.child.kill(); process.exit(1); }
const paired = await fetch(`http://127.0.0.1:${port}/pair`, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code }),
});
if (!paired.ok) { console.error("pairing failed:", await paired.text()); a.child.kill(); process.exit(1); }
const credentials = await paired.json() as { token: string; url: string };
a.child.kill("SIGTERM");
await a.child.exited;

// 2. The restart, and the phone back in the room at once.
const restartedAt = at();
const b = start("second");
const phone = new Transport();
const got: Array<{ at: number; value: Record<string, unknown> }> = [];
phone.onMessage((value) => got.push({ at: at(), value }));
await phone.connect(credentials.url, credentials.token, "warm-join");
const joinedAt = at();
const protocol = async () => {
  const stop = Date.now() + 60_000;
  while (!got.some((m) => m.value.kind === "protocol") && Date.now() < stop) await Bun.sleep(20);
};
await protocol();
// Mic tapped twice while the engines warm
await phone.send({ kind: "mic", on: false });
const cutAt = at();
await phone.send({ kind: "mic", on: true });

const warm = await b.first(/^bridge on /);
await Bun.sleep(1_000);
await phone.close();
b.child.kill("SIGTERM");
await b.child.exited;

// 3. The card's pass conditions, against the moment the bridge is warm.
const warmAt = warm?.at ?? Infinity;
const first = (kind: string, on?: boolean) => got.find((m) => m.value.kind === kind && (on === undefined || m.value.on === on))?.at ?? Infinity;
const cutLine = b.lines.find((entry) => entry.line === "[the phone cut its microphone]")?.at ?? Infinity;
const history = got.find((m) => m.value.kind === "history")?.value.turns;
const checks: Array<[string, boolean, string]> = [
  ["the phone joined before the bridge was warm", joinedAt < warmAt, `joined ${joinedAt} ms, warm ${warmAt} ms`],
  ["the protocol arrived before the bridge was warm", first("protocol") < warmAt, `${first("protocol")} ms`],
  ["the history arrived before the bridge was warm", first("history") < warmAt, `${first("history")} ms, ${Array.isArray(history) ? history.length : "no"} turns`],
  ["the phone was told the bridge starts, then that it is ready", first("starting", true) < warmAt && first("starting", false) < Infinity, `${first("starting", true)} ms, then ${first("starting", false)} ms`],
  ["the microphone cut landed before the bridge was warm", cutLine < warmAt, `sent ${cutAt} ms, journal ${cutLine} ms`],
];
console.log(`restart at ${restartedAt} ms, the new bridge warm at ${warmAt} ms`);
for (const [what, passed, detail] of checks) console.log(`${passed ? "pass" : "FAIL"}  ${what} (${detail})`);
process.exit(checks.every(([, passed]) => passed) ? 0 : 1);
