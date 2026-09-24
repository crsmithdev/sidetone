#!/usr/bin/env bun
/**
 * Whether the sound was bad at the bridge (spec 18.14).
 *
 * The agent cannot hear its own voice. This lets it read the voice instead:
 * the speech worker transcribes a clip the bridge sent, and the words are
 * compared with the text the clip was made from.
 *
 *   bun scripts/sent-check.ts               list the last clips, newest first
 *   bun scripts/sent-check.ts 1 3           check the newest and the third newest
 *   bun scripts/sent-check.ts x.wav --text "Muted."
 *                                           check any wav against a text
 *
 * It starts its own speech worker, which takes about 2 GB of the GPU and a few
 * seconds to warm. It exits 0 when every clip is clean, 1 when one is garbled
 * and 2 when it cannot tell.
 */
import { loadConfig } from "../src/config.ts";
import { SentClips, checkClip } from "../src/sent.ts";
import { LocalWhisper } from "../src/speech.ts";

const config = loadConfig();
const sent = new SentClips(config.sentDir);
const clips = sent.list();

const args = process.argv.slice(2);
const at = args.indexOf("--text");
const text = at >= 0 ? args[at + 1] : undefined;
const asked = at >= 0 ? args.filter((_, i) => i !== at && i !== at + 1) : args;

if (asked.length === 0) {
  if (!config.keepSentClips) console.log("keepSentClips is off: the bridge keeps no clips");
  if (clips.length === 0) fail(2, `no clips under ${config.sentDir}`);
  clips.forEach((clip, i) => console.log(`${String(i + 1).padStart(3)}  ${new Date(clip.at).toLocaleString()}  ${clip.source}  ${JSON.stringify(clip.text)}`));
  process.exit(0);
}

/** A number names the nth newest clip; anything else is a wav, and `--text` is its text. */
const targets = asked.map((arg) => {
  if (/^\d+$/.test(arg)) {
    const clip = clips[Number(arg) - 1];
    if (!clip) fail(2, `there is no clip ${arg}; ${clips.length} are kept`);
    return { wav: clip.wav, text: clip.text, label: `clip ${arg}, ${new Date(clip.at).toLocaleString()}, ${clip.source}` };
  }
  if (text === undefined) fail(2, `${arg} is not a clip number, so it needs --text`);
  return { wav: arg, text, label: arg };
});

const stt = new LocalWhisper(config, new URL("../speech", import.meta.url).pathname);
await stt.start().catch((error) => fail(2, `the speech worker did not start: ${(error as Error).message}`));
let garbled = false;
for (const target of targets) {
  const heard = await stt.transcribe(target.wav);
  const check = checkClip(await Bun.file(target.wav).bytes(), target.text, heard);
  garbled ||= check.garbled;
  console.log(target.label);
  console.log(`  text   ${JSON.stringify(target.text)}`);
  console.log(`  heard  ${JSON.stringify(heard)}`);
  console.log(`  ${check.ms} ms, ${check.sampleRate} Hz, ${check.channels} channel${check.channels === 1 ? "" : "s"}, peak ${check.peak.toFixed(2)}, likeness ${check.likeness.toFixed(2)}`);
  console.log(`  ${check.garbled ? "GARBLED" : "clean"}`);
}
stt.stop();
process.exit(garbled ? 1 : 0);

function fail(code: number, why: string): never {
  console.log(why);
  process.exit(code);
}
