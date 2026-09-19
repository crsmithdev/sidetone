#!/usr/bin/env bun
/**
 * The text round trip (spec 7.2). Voice comes at 7.3; this loop is useful on
 * its own, and it is where the process management gets tested.
 *
 *   bun src/main.ts chat <project-dir>    a spoken conversation, typed
 *   bun src/main.ts chat <dir> --record-stream <file>
 *                                         the same, with every line Claude Code prints kept as a fixture
 *   bun src/main.ts config                the settings and where they come from
 */
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, configPath, loadConfig, saveSettings, type Config } from "./config.ts";
import { Session, recorded, spawnClaude } from "./session.ts";
import { Conversation, keptLines } from "./conversation.ts";
import { Cues } from "./cues.ts";
import { decodeWav, utteranceOf } from "./audio.ts";
import { Ear } from "./ear.ts";
import { Measures } from "./measures.ts";
import { Mouth } from "./mouth.ts";
import { fetchCert } from "./keys.ts";
import { endpoints, livekitConfig } from "./serve.ts";
import { serve } from "./serve.ts";
import { LocalWhisper, SpokenAhead, textToSpeech } from "./speech.ts";

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
 * 5.1-5.2 the microphone, with the end of a turn found by the pause after it
 * (11.5). The recorder starts when the level comes up and stops itself after
 * the pause, so one call is one thing Chris said.
 */
function recorder(wav: string, config: Config) {
  const onset = (config.speechOnsetMs / 1000).toFixed(2);
  const pause = (config.endOfTurnPauseMs / 1000).toFixed(2);
  // sox says the same level in percent. It used to be its own setting, in its
  // own unit, and nothing kept the two in step.
  const threshold = `${(config.speechLevel * 100).toFixed(1)}%`;
  const record = `parecord --raw --channels=1 --rate=16000 --format=s16le 2>/dev/null` +
    ` | sox -t raw -r 16000 -e signed -b 16 -c 1 - ${wav}` +
    ` silence 1 ${onset} ${threshold} 1 ${pause} ${threshold}`;
  return Bun.spawn(["bash", "-c", record], { stdout: "ignore", stderr: "ignore" });
}

/** 5.9 play one sentence. Sentences are played in order, never on top of each other. */
async function play(wav: string): Promise<void> {
  await Bun.spawn(["paplay", wav], { stdout: "ignore", stderr: "ignore" }).exited;
}

/** VOICE_BRIDGE_DEBUG=1 traces the microphone, which is the part that cannot be watched. */
const trace = process.env.VOICE_BRIDGE_DEBUG
  ? (text: string) => console.log(`    . ${new Date().toISOString().slice(14, 22)} ${text}`)
  : () => {};

/**
 * 7.3 the spoken loop at the desk, on the machine's own devices.
 *
 * Every sound the bridge makes stops the microphone first. There is no echo
 * cancellation here, so a recording that ran through the bridge's own voice
 * would be transcribed back as a question. 7.4 hands that problem to LiveKit
 * (4.2) and this loop becomes the local fallback.
 */
async function voice(dir: string, config: Config): Promise<void> {
  const scratch = mkdtempSync(join(tmpdir(), "voice-bridge-"));
  const speechDir = new URL("../speech", import.meta.url).pathname;
  const stt = new LocalWhisper(config, speechDir);
  const tts = textToSpeech(config, speechDir);
  const ahead = new SpokenAhead(tts, scratch, keptLines(config));
  const cues = new Cues(scratch, config.cueVolume);

  const startedAt = Date.now();
  await Promise.all([stt.start(), tts.start(), cues.build()]);
  console.log(`voice ready in ${((Date.now() - startedAt) / 1000).toFixed(1)}s: ${config.sttModel} and ${config.ttsEngine} ${config.ttsVoice}, both local`);

  let counter = 0;
  /** The recording the ear is reading, so the engine reads the file sox wrote. */
  let heardWav = "";
  let speech = 0;
  let pending = 0;
  let listening: ReturnType<typeof recorder> | null = null;

  /**
   * Every sound the bridge makes stops the microphone first. Without this a
   * single recording spans the bridge's own voice and the answer to it, and the
   * whole recording is then thrown away as self-heard: the checkpoint asks for
   * the agreement word and cannot hear it.
   */
  function takeTheMicrophone(): void {
    speech += 1;
    pending += 1;
    try { listening?.kill(); } catch { /* already gone */ }
    listening = null;
  }

  /** 7.3 the one thing the desk does that the room does not: it plays on the machine's own devices. */
  const mouth = new Mouth({
    async play(text, wav) {
      takeTheMicrophone();
      try {
        console.log(`  ${text}`);
        if (wav) await play(wav);
      } finally { pending -= 1; }
      // there is no barge-in at the desk (7.3), so a sentence is always whole
      return true;
    },
    /**
     * A cue does not take the microphone. It is a tone: the voice detector
     * drops it and no transcription can mistake it for words, so it may sit
     * inside a recording that also holds what Chris said. When cues did take
     * the microphone, one every seven seconds shredded every listening window.
     */
    cue(wav) { void play(wav); },
  }, ahead, cues, new Measures(), config);

  const conversation = new Conversation(dir, config, mouth, tts, {
    onNarration: (text) => console.log(`[${text}]`),
    onSetting: (patch) => { Object.assign(config, patch); saveSettings(patch); conversation.measures.setting(patch); },
    onTurn: (turn) => console.log(`[turn ${turn.number}, $${conversation.agent.totalCostUsd().toFixed(4)} this session]`),
  });
  /**
   * 7.3 and 7.4 hear the same way. The desk has no frames to push, so it hands
   * the ear whole recordings; everything after that — the invention guard, the
   * clock, the cue, an empty transcription — is the module's, not the loop's.
   */
  // the detector settings are inert here: the desk pushes no frames, sox finds
  // the ends of a turn itself, and the rate is the one it records at
  const ear = new Ear(conversation, () => stt.transcribe(heardWav), { ...config, sampleRate: 16_000 }, conversation.measures);

  conversation.start();
  console.log(`Claude Code in ${dir}. Speak; a ${(config.endOfTurnPauseMs / 1000).toFixed(1)}s pause ends your turn.`);
  console.log(`Say "${config.wakeWord}" then a command. Ctrl-C to leave.`);

  for (;;) {
    while (pending > 0) await Bun.sleep(50);
    // the speakers hold a little audio after the last sentence ends
    await Bun.sleep(config.listenSettleMs);
    if (pending > 0) continue;
    const before = speech;
    const wav = join(scratch, `heard-${++counter}.wav`);
    trace("listening");
    listening = recorder(wav, config);
    await listening.exited;
    listening = null;
    if (speech !== before || pending > 0) { trace("cut short: the bridge started to speak"); continue; }
    heardWav = wav;
    await ear.said(utteranceOf(decodeWav(await Bun.file(wav).bytes()), config.speechLevel));
  }
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
  const scratch = mkdtempSync(join(tmpdir(), "voice-bridge-warm-"));
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
} else if (command === "voice") {
  const dir = rest[0];
  if (!dir) { console.error("usage: bun src/main.ts voice <project-dir>"); process.exit(2); }
  await voice(dir, config);
} else if (command === "warm") {
  await warm(config);
} else if (command === "cert") {
  // 12.1 a phone refuses the microphone over a certificate it does not trust
  const dir = join(homedir(), ".voice-bridge");
  const result = fetchCert(join(dir, "tls-cert.pem"), join(dir, "tls-key.pem"));
  console.log(result.message);
  if (result.ok) console.log("\nPoint tlsCert and tlsKey at those two, and restart the bridge.");
  else process.exit(1);
} else if (command === "livekit") {
  // 12.1 the server and the bridge have to hold the same keys, so one place writes both
  const { host, keys } = endpoints(config);
  const path = join(homedir(), ".voice-bridge", "livekit.yaml");
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
  console.error("usage: bun src/main.ts <chat <dir> | voice <dir> | serve <dir> | warm | livekit | cert | config>");
  process.exit(2);
}
