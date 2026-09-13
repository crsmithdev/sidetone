import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cues } from "../src/cues.ts";
import { decodeWav } from "../src/audio.ts";

const VOLUME = 0.12;
const built = new Cues(mkdtempSync(join(tmpdir(), "cues-")), VOLUME);
await built.build();

async function samples(name: "heard" | "thinking" | "starting") {
  const wav = built.file(name);
  expect(wav).toBeDefined();
  return decodeWav(await Bun.file(wav as string).bytes());
}

describe("the cues (15)", () => {
  test("all three are built, and the transport can read them", async () => {
    for (const name of ["heard", "thinking", "starting"] as const) {
      const wav = await samples(name);
      expect(wav.sampleRate).toBe(22050);
      expect(wav.channels).toBe(1);
    }
  });

  test("15.5 a routine cue stays short", async () => {
    for (const name of ["heard", "thinking", "starting"] as const) {
      const wav = await samples(name);
      const seconds = wav.samples.length / wav.sampleRate;
      expect(seconds).toBeGreaterThan(0.1);
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
    for (const name of ["heard", "thinking", "starting"] as const) {
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
});
