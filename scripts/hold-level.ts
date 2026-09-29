/**
 * 15.10.4 the level of a start of a hold track, as the bridge sends it and as
 * a phone receives it (item 70).
 *
 *   bun scripts/hold-level.ts                       # the first track in the hold folder
 *   bun scripts/hold-level.ts --track "Summer Madness" --stop 30
 *   bun scripts/hold-level.ts --wav desk.m4a --track "Feels So Good"
 *
 * A real `Mouth` plays one track through `Mouth.music` twice: the first start,
 * stopped after `--stop` seconds, and then the resume, which starts two
 * seconds before the stop (15.10.1). Its speaker is a real `Transport` in a
 * room of its own, never the live room, and a second `Transport` in that room
 * receives the frames the way the phone does. For each start the script writes
 * the RMS of the first 2 s in 50 ms windows: what the bridge sent, from the
 * first sample of the fade in, and what the other end received, from the same
 * place. The received audio is also written as a WAV file, to listen to.
 *
 * With `--wav` it writes the same table for a recording in any format ffmpeg
 * reads, for the desk test of item 70. The recording must start in quiet: its
 * first 500 ms is the noise floor, and the first sound is the first 10 ms
 * louder than four times that floor. With `--track` it adds what the bridge
 * sends for a first start of that track, and the ratio of the two, scaled so
 * that its median is 1. A ratio that falls through the first second is a gain
 * control after the bridge turning the level down.
 */
import { mkdtempSync, readdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { decodeWav, encodeWav, wavFromFile } from "../src/audio.ts";
import { loadConfig } from "../src/config.ts";
import { Measures } from "../src/measures.ts";
import { Mouth, fadeIn, firstSound } from "../src/mouth.ts";
import { endpoints } from "../src/serve.ts";
import { RTC_RATE, Transport, resample, roomSpeaker } from "../src/transport.ts";

const WINDOW_MS = 50;
const SPAN_MS = 2_000;
/** The first sample louder than this is where a start begins: about -66 dBFS. */
const ONSET = 16;

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

function onset(samples: Int16Array): number {
  const at = samples.findIndex((sample) => Math.abs(sample) > ONSET);
  return at < 0 ? 0 : at;
}

/** The RMS of each window of the first `SPAN_MS`, from `from`, as a fraction of full scale. */
function windows(samples: Int16Array, rate: number, from: number): number[] {
  const size = (rate * WINDOW_MS) / 1000;
  const out: number[] = [];
  for (let at = from; at < from + (rate * SPAN_MS) / 1000; at += size) {
    out.push(windowRms(samples.subarray(at, at + size)));
  }
  return out;
}

function table(title: string, columns: Record<string, number[]>): void {
  const names = Object.keys(columns);
  console.log(`\n${title}\n| ms | ${names.join(" | ")} |\n|---:|${names.map(() => "---:").join("|")}|`);
  const rows = Math.max(...Object.values(columns).map((column) => column.length));
  for (let i = 0; i < rows; i++) {
    console.log(`| ${i * WINDOW_MS}-${(i + 1) * WINDOW_MS} | ${names.map((name) => (columns[name]![i] ?? 0).toFixed(4)).join(" | ")} |`);
  }
}

/** The first sound of a recording made in a room: louder than four times the floor of its first 500 ms. */
function soundOnset(samples: Int16Array): { at: number; floor: number } {
  const block = RTC_RATE / 100;
  const rms = (at: number, length: number) => windowRms(samples.subarray(at, at + length));
  const floor = rms(0, RTC_RATE / 2);
  for (let at = RTC_RATE / 2; at < samples.length; at += block) {
    if (rms(at, block) > Math.max(4 * floor, ONSET / 32768)) return { at, floor };
  }
  return { at: 0, floor };
}

function windowRms(block: Int16Array): number {
  let sum = 0;
  for (const sample of block) sum += sample * sample;
  return block.length ? Math.sqrt(sum / block.length) / 32768 : 0;
}

const config = loadConfig();
const names = readdirSync(config.holdMusicFolder).filter((name) => !name.includes(":")).sort();
const wanted = argument("--track");
const name = names.find((candidate) => !wanted || candidate.includes(wanted));
if (!name) { console.error(`no track matches ${wanted} in ${config.holdMusicFolder}`); process.exit(1); }

const recording = argument("--wav");
if (recording) {
  const samples = decodeWav(await wavFromFile(recording, RTC_RATE)).samples;
  const { at, floor } = soundOnset(samples);
  const recorded = windows(samples, RTC_RATE, at);
  if (!wanted) {
    table(`${basename(recording)}, from its first sound at ${(at / RTC_RATE).toFixed(2)} s, floor ${floor.toFixed(4)}`, { recorded });
    process.exit(0);
  }
  // a first start as the bridge sends it: the track at its gain, faded in, from its first sound
  const track = decodeWav(await wavFromFile(join(config.holdMusicFolder, name), RTC_RATE, config.holdMusicGain)).samples;
  const faded = fadeIn(track.subarray(firstSound(track, 0, RTC_RATE, config.holdMusicGain)), (RTC_RATE * config.holdMusicFadeInMs) / 1000);
  const sent = windows(faded, RTC_RATE, onset(faded));
  const ratios = recorded.map((level, i) => level / Math.max(sent[i]!, 1e-6));
  const median = ratios.toSorted((a, b) => a - b)[ratios.length >> 1]!;
  table(`${basename(recording)} against a first start of ${name}, each from its first sound; recording floor ${floor.toFixed(4)}`, {
    recorded, sent, ratio: ratios.map((ratio) => ratio / median),
  });
  process.exit(0);
}

const stopS = Number(argument("--stop") ?? 30);

// a folder of one track, so the second start is the resume of the first (15.10.1)
const scratch = mkdtempSync(join(tmpdir(), "hold-level-"));
const folder = join(scratch, "hold");
await Bun.$`mkdir -p ${folder}`;
symlinkSync(join(config.holdMusicFolder, name), join(folder, name));

const { keys } = endpoints(config);
const room = `hold-level-${Date.now()}`;
const bridge = new Transport();
const phone = new Transport();
await bridge.join(keys, room, "hold-level-bridge");
await phone.join(keys, room, "hold-level-phone");

let received: number[] = [];
phone.onAudio((frame) => { for (const sample of frame) received.push(sample); }, () => {});

/** What the bridge sent: the WAV `Mouth.music` gave the speaker, as the transport resamples it. */
let sent: Int16Array = new Int16Array(0);
const speaker = roomSpeaker({
  speak(wav, until, fade) {
    const decoded = decodeWav(wav);
    sent = resample(decoded.samples, decoded.sampleRate, RTC_RATE);
    return bridge.speak(wav, until, fade);
  },
  get speaking() { return bridge.speaking; },
}, () => {});
const mouth = new Mouth(speaker, {} as never, {} as never, new Measures(), {
  ...config,
  // the room is the script's own: the live audio switch does not apply
  audio: true,
  music: { folder, gain: config.holdMusicGain, rate: RTC_RATE, fadeMs: config.holdMusicFadeMs, fadeInMs: config.holdMusicFadeInMs },
  say: (line) => console.log(line),
});
// the phone subscribes a moment after the track appears
await Bun.sleep(3_000);

console.log(`track ${name}, gain ${config.holdMusicGain}, fade in ${config.holdMusicFadeInMs} ms, room ${room}`);
for (const [label, playS] of [["first start", stopS], ["resume", 6]] as const) {
  received = [];
  const startedAt = Date.now();
  if (!(await mouth.music(() => Date.now() - startedAt > playS * 1000))) { console.error(`${label}: the track did not start`); process.exit(1); }
  await Bun.sleep(playS * 1000 + 1_500);
  const heard = Int16Array.from(received);
  const out = join(scratch, `${label.replace(" ", "-")}.wav`);
  await Bun.write(out, encodeWav(heard, RTC_RATE));
  // the sent audio from its first sample, where the fade begins; the received
  // audio from the same place, found by the first sound in each
  const from = Math.max(0, onset(heard) - onset(sent));
  table(`${label}: received from sample ${from} (${out})`, {
    sent: windows(sent, RTC_RATE, 0),
    received: windows(heard, RTC_RATE, from),
  });
}

await phone.close();
await bridge.close();
process.exit(0);
