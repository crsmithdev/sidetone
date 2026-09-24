import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cues, type CueName } from "../src/cues.ts";
import { decodeWav } from "../src/audio.ts";

const VOLUME = 0.12;
const built = new Cues(mkdtempSync(join(tmpdir(), "cues-")), VOLUME);
await built.build();

const ALL = ["heard", "thinking", "starting", "hold", "release", "done"] as const;

/** 15.14 and 15.15 the cues that are half the length of the others. */
const SHORT = new Set<CueName>(["hold", "release", "done"]);

async function samples(name: CueName) {
  const wav = built.file(name);
  expect(wav).toBeDefined();
  return decodeWav(await Bun.file(wav as string).bytes());
}

describe("the cues (15)", () => {
  test("all six are built, and the transport can read them", async () => {
    for (const name of ALL) {
      const wav = await samples(name);
      expect(wav.sampleRate).toBe(22050);
      expect(wav.channels).toBe(1);
    }
  });

  // A click is short, so the floor only checks that there is a sound at all.
  // A short cue is half the length again (15.14, 15.15), so it has its own floor.
  test("15.5 a routine cue stays short", async () => {
    for (const name of ALL) {
      const wav = await samples(name);
      const seconds = wav.samples.length / wav.sampleRate;
      const floor = SHORT.has(name) ? 0.03 : 0.05;
      expect(seconds).toBeGreaterThan(floor);
      expect(seconds).toBeLessThan(0.35);
    }
  });

  /**
   * The bug this replaces: sox starts a new effect chain at ":", so a single
   * trailing vol reached the last note only and the first came out at full
   * scale. Peak over the whole file hid it, because the file's peak was the
   * loud note. Every window has to be quiet, not just the average.
   */
  test("no window of any cue is louder than cueVolume", async () => {
    for (const name of ALL) {
      const wav = await samples(name);
      const window = Math.floor(wav.sampleRate * 0.02);
      for (let at = 0; at + window <= wav.samples.length; at += window) {
        let peak = 0;
        for (let i = at; i < at + window; i++) peak = Math.max(peak, Math.abs(wav.samples[i] as number));
        expect(peak / 32768).toBeLessThanOrEqual(VOLUME + 0.005);
      }
    }
  });

  test("the level follows the setting", async () => {
    const quiet = new Cues(mkdtempSync(join(tmpdir(), "cues-quiet-")), 0.03);
    await quiet.build();
    const wav = decodeWav(await Bun.file(quiet.file("thinking") as string).bytes());
    let peak = 0;
    for (const sample of wav.samples) peak = Math.max(peak, Math.abs(sample));
    expect(peak / 32768).toBeLessThanOrEqual(0.035);
    expect(peak / 32768).toBeGreaterThan(0.02);
  });

  test("15.14 the hold to talk cues are shorter and quieter than the others, and differ", async () => {
    const peak = (wav: { samples: Int16Array }) => wav.samples.reduce((most, sample) => Math.max(most, Math.abs(sample)), 0) / 32768;
    const heard = await samples("heard");
    for (const name of ["hold", "release"] as const) {
      const wav = await samples(name);
      expect(wav.samples.length).toBeLessThan(heard.samples.length);
      expect(peak(wav)).toBeLessThanOrEqual(VOLUME / 2 + 0.005);
      expect(peak(wav)).toBeGreaterThan(VOLUME / 4);
    }
    const hold = await samples("hold");
    const release = await samples("release");
    expect(hold.samples).not.toEqual(release.samples);
  });

  /**
   * 15.15 the cue at the end of the speech is the thinking cue backwards: two
   * clicks, dark then bright. Brightness is read as zero crossings a second,
   * which a band of noise has more of the higher the band sits. The second
   * click starts where the sound first reaches half its peak after the first
   * click has died away.
   */
  test("15.15 the end cue is two clicks, dark to bright, shorter and quieter than the thinking cue", async () => {
    const done = await samples("done");
    const thinking = await samples("thinking");
    const peak = (wav: { samples: Int16Array }) => wav.samples.reduce((most, sample) => Math.max(most, Math.abs(sample)), 0) / 32768;
    expect(done.samples.length).toBeLessThan(thinking.samples.length);
    expect(peak(done)).toBeLessThanOrEqual(VOLUME / 2 + 0.005);
    expect(peak(done)).toBeGreaterThan(VOLUME / 4);
    const crossings = (samples: Int16Array, from: number, length: number) => {
      let count = 0;
      for (let i = from + 1; i < from + length; i++) if ((samples[i - 1] as number) < 0 !== (samples[i] as number) < 0) count++;
      return count;
    };
    const click = Math.floor(done.sampleRate * 0.015);
    const half = peak(done) * 32768 / 2;
    let second = Math.floor(done.sampleRate * 0.05);
    while (second < done.samples.length && Math.abs(done.samples[second] as number) < half) second++;
    expect(second).toBeLessThan(done.samples.length);
    const first = crossings(done.samples, 0, click);
    expect(crossings(done.samples, second, click)).toBeGreaterThan(first * 1.3);
    // the thinking cue runs the other way: its first click is the bright one
    expect(crossings(thinking.samples, 0, click)).toBeGreaterThan(first * 1.3);
  });
});
