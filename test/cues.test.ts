import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cues, type CueName } from "../src/cues.ts";
import { decodeWav } from "../src/audio.ts";

const VOLUME = 0.12;
const built = new Cues(mkdtempSync(join(tmpdir(), "cues-")), VOLUME);
await built.build();

const ALL = ["heard", "thinking", "starting", "hold", "release"] as const;

async function samples(name: CueName) {
  const wav = built.file(name);
  expect(wav).toBeDefined();
  return decodeWav(await Bun.file(wav as string).bytes());
}

describe("the cues (15)", () => {
  test("all five are built, and the transport can read them", async () => {
    for (const name of ALL) {
      const wav = await samples(name);
      expect(wav.sampleRate).toBe(22050);
      expect(wav.channels).toBe(1);
    }
  });

  // A click is short, so the floor only checks that there is a sound at all.
  // A hold cue is half the length again (15.14), so it has its own floor.
  test("15.5 a routine cue stays short", async () => {
    for (const name of ALL) {
      const wav = await samples(name);
      const seconds = wav.samples.length / wav.sampleRate;
      const floor = name === "hold" || name === "release" ? 0.03 : 0.05;
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
});
