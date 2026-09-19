#!/usr/bin/env bun
/**
 * What the engine writes when Chris says a command (spec 9.3, 18.8).
 *
 * The matcher forgives spelling because a speech engine does not produce the
 * word you said, it produces a word that sounded like it. Twice in one week a
 * command shipped that the engine never wrote the expected way: "male voice"
 * comes back as "Mail Voice", "end the turn" as "in the turn". Both were found
 * in a live run, which is an expensive place to find them.
 *
 * This says every phrase out loud, buries it in noise, reads it back, and
 * records what came out. The result is test/fixtures/heard.json, which
 * test/heard.test.ts then checks without needing any of this. Run it after
 * adding a command, or before a drive.
 *
 * Synthetic speech is not Chris in a car: the forms it finds are real, and the
 * ones it does not find may still be out there. It is a floor, not a ceiling.
 *
 *   bun scripts/heard-refresh.ts            everything
 *   bun scripts/heard-refresh.ts male       only phrases matching a string
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spokenForms } from "../src/commands.ts";
import { DEFAULTS, loadConfig } from "../src/config.ts";
import { LocalWhisper, textToSpeech } from "../src/speech.ts";

/**
 * Every command's phrases come from the table in src/commands.ts, so a new
 * command is in the corpus the next time this runs. The rest is what must not
 * be mistaken for one: the wake word run into the command, the wake word with
 * nothing usable after it, and ordinary speech for the agent.
 */
const PHRASES: Array<{ said: string; want: string | null }> = [
  ...spokenForms(DEFAULTS.wakeWord),
  { said: "hey bridgemute", want: "mute" },
  // 9.7 the wake word arrives and the command does not
  { said: "hey bridge, wobble", want: "unclear" },
  // ordinary speech, which must reach the agent untouched
  { said: "What does the serve command actually do?", want: null },
  { said: "The bridge is ready, so let us land it.", want: null },
  { said: "Can you summarize the last commit for me?", want: null },
  { said: "Tell me where the barge in detector lives.", want: null },
];

/** Two voices, because one timbre is one opinion. */
const VOICES = ["am_michael", "af_heart"];
/** Clean, then a car. Brown noise at a measured ratio to the speech. */
const SNRS: Array<number | null> = [null, 10, 0, -5];

const FIXTURE = new URL("../test/fixtures/heard.json", import.meta.url).pathname;

async function sox(args: string[]): Promise<void> {
  // -R seeds the noise. Without it every run draws a different bed and the
  // fixture grows spellings that nobody can reproduce.
  const done = await Bun.spawn(["sox", "-R", ...args], { stdout: "ignore", stderr: "pipe" });
  if (await done.exited !== 0) throw new Error(`sox ${args.join(" ")}: ${await new Response(done.stderr).text()}`);
}

async function rmsOf(wav: string): Promise<number> {
  const out = await new Response(Bun.spawn(["sox", wav, "-n", "stat"], { stderr: "pipe" }).stderr).text();
  return Number(out.match(/RMS\s+amplitude:\s+(\S+)/)?.[1] ?? 0);
}

async function secondsOf(wav: string): Promise<number> {
  const out = await new Response(Bun.spawn(["sox", wav, "-n", "stat"], { stderr: "pipe" }).stderr).text();
  return Number(out.match(/Length \(seconds\):\s+(\S+)/)?.[1] ?? 0);
}

/** The same speech with a car around it, at a ratio measured on this clip. */
async function atSnr(clean: string, out: string, snr: number, scratch: string): Promise<void> {
  const speech = await rmsOf(clean);
  const raw = join(scratch, "noise-raw.wav");
  await sox(["-n", "-r", "24000", "-c", "1", "-b", "16", "-e", "signed-integer", raw,
    "synth", (await secondsOf(clean)).toFixed(3), "brownnoise", "lowpass", "900"]);
  const level = speech / 10 ** (snr / 20) / (await rmsOf(raw) || 1);
  const scaled = join(scratch, "noise.wav");
  await sox([raw, scaled, "vol", level.toFixed(5)]);
  await sox(["-m", clean, scaled, out]);
}

const only = process.argv[2];
const config = loadConfig();
const scratch = mkdtempSync(join(tmpdir(), "heard-"));
const speechDir = new URL("../speech", import.meta.url).pathname;
const tts = textToSpeech(config, speechDir);
const stt = new LocalWhisper(config, speechDir);
await Promise.all([tts.start(), stt.start()]);
if (!tts.use) throw new Error("this engine cannot change voice, so the corpus would be one timbre");

const existing = await Bun.file(FIXTURE).json().catch(() => ({ phrases: [] })) as
  { phrases: Array<{ said: string; want: string | null; heard: string[] }> };
const known = new Map(existing.phrases.map((p) => [p.said, new Set(p.heard)]));

let added = 0;
for (const { said, want } of PHRASES) {
  if (only && !said.includes(only)) continue;
  const heard = known.get(said) ?? new Set<string>();
  known.set(said, heard);
  for (const voice of VOICES) {
    tts.use(voice);
    const clean = join(scratch, "clean.wav");
    await tts.synthesize(said.replace(/,/g, ","), clean);
    for (const snr of SNRS) {
      const wav = snr === null ? clean : join(scratch, "noisy.wav");
      if (snr !== null) await atSnr(clean, wav, snr, scratch);
      const text = (await stt.transcribe(wav)).trim();
      if (!text || heard.has(text)) continue;
      heard.add(text);
      added += 1;
      console.log(`  + ${said.padEnd(36)} ${snr === null ? "clean" : `${snr} dB`.padStart(5)}  "${text}"`);
    }
  }
}

const phrases = PHRASES
  .filter((p) => known.has(p.said))
  .map((p) => ({ said: p.said, want: p.want, heard: [...(known.get(p.said) ?? [])].sort() }));
await Bun.write(FIXTURE, `${JSON.stringify({
  note: "What faster-whisper wrote when the voice said each phrase, clean and in brown noise at 10, 0 and -5 dB. Regenerate with scripts/heard-refresh.ts.",
  phrases,
}, null, 1)}\n`);
tts.stop(); stt.stop();
console.log(`\n${added} new spellings; ${phrases.reduce((n, p) => n + p.heard.length, 0)} in the fixture`);
