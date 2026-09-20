#!/usr/bin/env bun
/**
 * The command line. The text round trip of 7.2 is here, because it is where
 * the process management gets tested; the spoken one is `serve`, in serve.ts.
 * The desk loop that built 7.3 is gone: it had no barge-in, no record and no
 * test, and the fake phone is the scripted spoken run now.
 *
 *   bun src/main.ts chat <project-dir>    a spoken conversation, typed
 *   bun src/main.ts chat <dir> --record-stream <file>
 *                                         the same, with every line Claude Code prints kept as a fixture
 *   bun src/main.ts config                the settings and where they come from
 */
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, configPath, loadConfig, type Config } from "./config.ts";
import { Session, recorded, spawnClaude } from "./session.ts";
import { keptLines } from "./mouth.ts";
import { fetchCert } from "./keys.ts";
import { endpoints, livekitConfig, serve } from "./serve.ts";
import { SpokenAhead, textToSpeech } from "./speech.ts";

function showConfig(config: Config): void {
  console.log(`config: ${configPath()}`);
  for (const [key, value] of Object.entries(config)) {
    const isDefault = JSON.stringify(value) === JSON.stringify(DEFAULTS[key as keyof Config]);
    console.log(`  ${key} = ${JSON.stringify(value)}${isDefault ? "" : "   (set)"}`);
  }
}

async function chat(dir: string, config: Config, recordStream = ""): Promise<void> {
  // 5.5 the reply arrives word by word. Here it goes straight to the terminal;
  // at 7.3 the same hook feeds the sentence collector of 5.6.
  let streamed = false;
  // a run worth keeping becomes a file a test replays through the session
  const spawn = recordStream ? recorded(spawnClaude, recordStream) : spawnClaude;
  const session = new Session(dir, config, {
    onDelta: (text) => { streamed = true; process.stdout.write(text); },
    // 2.3 at 7.3 this is spoken; here it keeps a long turn from looking hung
    onNarration: (text) => console.log(`[${text}]`),
    onCheckpoint: (ms) => console.log(`\n[this turn has run ${Math.round(ms / 60_000)} minutes. say "${config.agreementWord}" to let it run]`),
    onInterrupt: (reason) => console.log(`\n[interrupting the turn: ${reason}]`),
    onRestart: (reason) => console.log(`\n[restarting Claude Code: ${reason}]`),
  }, spawn);
  session.start();
  console.log(`Claude Code in ${dir}, model ${config.model}. Ctrl-D to leave.`);

  for await (const line of console) {
    const text = line.trim();
    if (!text) continue;
    // 8.6.4 the agreement word is heard here in text, and by voice at 7.3
    if (text.toLowerCase() === config.agreementWord.toLowerCase()) { session.agree(); console.log("[continuing]"); continue; }
    try {
      streamed = false;
      const turn = await session.ask(text);
      console.log(streamed ? "\n" : `\n${turn.text}\n`);
      const fraction = session.contextFraction();
      const context = fraction === null ? "" : `, context ${Math.round(fraction * 100)}% of the compaction threshold`;
      console.log(`[turn ${turn.number}, $${session.totalCostUsd().toFixed(4)} this session${context}]`);
    } catch (error) {
      console.log(`\n[${(error as Error).message}]`);
    }
  }
  session.stop();
}

/**
 * 11.6 make the bridge's own sentences before they are needed.
 *
 * Every line it says in its own voice -- "Muted.", "Tones off." -- costs a
 * synthesis the first time, and with the cloning voice that is two and a half
 * seconds arriving after a command that should be answered at once. This makes
 * them all, once, and they are kept until the voice or its settings change.
 */
async function warm(config: Config): Promise<void> {
  const speechDir = new URL("../speech", import.meta.url).pathname;
  const scratch = mkdtempSync(join(tmpdir(), "sidetone-warm-"));
  const tts = textToSpeech(config, speechDir);
  const startedAt = Date.now();
  await tts.start();
  console.log(`${config.ttsEngine} ${config.ttsVoice} ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
  const ahead = new SpokenAhead(tts, scratch, keptLines(config));
  const at = Date.now();
  const made = await ahead.warm((text, fresh) => console.log(`  ${fresh ? "made" : "kept"}  ${text}`));
  console.log(`${made} made in ${((Date.now() - at) / 1000).toFixed(1)}s, under ${config.spokenDir}`);
  tts.stop();
}

const [command, ...rest] = process.argv.slice(2);
const config = loadConfig();

if (command === "config") {
  showConfig(config);
} else if (command === "chat") {
  const dir = rest[0];
  if (!dir) { console.error("usage: bun src/main.ts chat <project-dir> [--record-stream <file>]"); process.exit(2); }
  const at = rest.indexOf("--record-stream");
  await chat(dir, config, at >= 0 ? rest[at + 1] ?? "" : "");
} else if (command === "warm") {
  await warm(config);
} else if (command === "cert") {
  // 12.1 a phone refuses the microphone over a certificate it does not trust
  const dir = join(homedir(), ".sidetone");
  const result = fetchCert(join(dir, "tls-cert.pem"), join(dir, "tls-key.pem"));
  console.log(result.message);
  if (result.ok) console.log("\nPoint tlsCert and tlsKey at those two, and restart the bridge.");
  else process.exit(1);
} else if (command === "livekit") {
  // 12.1 the server and the bridge have to hold the same keys, so one place writes both
  const { host, keys } = endpoints(config);
  const path = join(homedir(), ".sidetone", "livekit.yaml");
  await Bun.write(path, livekitConfig({ apiKey: keys.apiKey, apiSecret: keys.apiSecret }, host, config.livekitPort));
  console.log(`wrote ${path}, advertising ${host}`);
  console.log("");
  console.log("docker run -d --name livekit --network host \\");
  console.log(`  -v ${path}:/livekit.yaml \\`);
  console.log("  livekit/livekit-server --config /livekit.yaml");
} else if (command === "serve") {
  const dir = rest[0];
  if (!dir) { console.error("usage: bun src/main.ts serve <project-dir>"); process.exit(2); }
  await serve(dir, config);
} else {
  console.error("usage: bun src/main.ts <chat <dir> | serve <dir> | warm | livekit | cert | config>");
  process.exit(2);
}
