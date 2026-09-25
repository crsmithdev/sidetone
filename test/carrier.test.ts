import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cutWav, decodeWav, encodeWav } from "../src/audio.ts";
import { CARRIERS, KEPT_LINES, keptLines } from "../src/mouth.ts";
import { DEFAULTS } from "../src/config.ts";
import { clipCutter, spanOf } from "../src/carrier.ts";
import type { HeardWord } from "../src/speech.ts";

const RATE = 24_000;
const scratchDir = () => mkdtempSync(join(tmpdir(), "carrier-"));

/** A second and a half of silence with a tone from `fromSec` to `toSec`, and where the tone is. */
function wavWithTone(fromSec: number, toSec: number, seconds = 1.5): Int16Array {
  const samples = new Int16Array(Math.round(seconds * RATE));
  for (let i = Math.round(fromSec * RATE); i < Math.round(toSec * RATE); i++) samples[i] = Math.round(Math.sin(i / 5) * 16_000);
  return samples;
}

/** The first and last sample above the noise floor, in seconds. */
function soundSpan(samples: Int16Array): { from: number; to: number } {
  let first = -1;
  let last = -1;
  for (let i = 0; i < samples.length; i++) {
    if (Math.abs(samples[i]!) < 1_000) continue;
    if (first < 0) first = i;
    last = i;
  }
  return { from: first / RATE, to: last / RATE };
}

/** "The answer has stopped.", as the speech worker times it: the words run on into each other. */
const HEARD: HeardWord[] = [
  { word: "The", start: 0.1, end: 0.3 },
  { word: "answer", start: 0.3, end: 0.6 },
  { word: "has", start: 0.6, end: 0.8 },
  { word: "stopped.", start: 0.8, end: 1.3 },
];

describe("where the line sits in what was heard (11.6.3)", () => {
  test("the span runs from the first of the line's words to the last, with the neighbours as the bounds", () => {
    expect(spanOf(HEARD, "Stopped.")).toEqual({ from: 0.8, to: 1.3, before: 0.8, after: null });
    expect(spanOf(HEARD, "answer has")).toEqual({ from: 0.3, to: 0.8, before: 0.3, after: 0.8 });
  });

  test("case and punctuation do not matter; order and completeness do", () => {
    expect(spanOf(HEARD, "STOPPED")).not.toBeNull();
    expect(spanOf(HEARD, "has answer")).toBeNull();
    expect(spanOf(HEARD, "Stopped now.")).toBeNull();
    expect(spanOf([], "Stopped.")).toBeNull();
  });

  test("when the words are said twice, the last run is the line", () => {
    const twice: HeardWord[] = [
      { word: "I", start: 0, end: 0.3 }, { word: "stopped", start: 0.3, end: 0.5 }, { word: "the", start: 0.5, end: 0.7 },
      { word: "answer.", start: 0.7, end: 1.0 }, { word: "Stopped.", start: 1.4, end: 1.7 },
    ];
    expect(spanOf(twice, "Stopped.")).toEqual({ from: 1.4, to: 1.7, before: 1.0, after: null });
  });

  test("a pause before the line is a bound, not a part of the line", () => {
    const paused: HeardWord[] = [{ word: "over.", start: 0.1, end: 0.5 }, { word: "Stopped.", start: 0.9, end: 1.3 }];
    expect(spanOf(paused, "Stopped.")).toEqual({ from: 0.9, to: 1.3, before: 0.5, after: null });
  });
});

describe("the cut (11.6.3)", () => {
  test("a cut keeps the sound between the two times and nothing else", () => {
    const wav = { sampleRate: RATE, channels: 1, samples: wavWithTone(0.8, 1.3) };
    const cut = cutWav(wav, 0.8, 1.3);
    expect(cut.sampleRate).toBe(RATE);
    expect(cut.samples.length).toBe(Math.round(0.5 * RATE));
    const sound = soundSpan(cut.samples);
    expect(sound.from).toBeLessThan(0.02);
    expect(sound.to).toBeGreaterThan(0.48);
  });

  test("the ends are faded, so a cut in the middle of a sound does not click", () => {
    const wav = { sampleRate: RATE, channels: 1, samples: wavWithTone(0, 1.5) };
    const cut = cutWav(wav, 0.5, 1.0);
    expect(Math.abs(cut.samples[0]!)).toBeLessThan(200);
    expect(Math.abs(cut.samples[cut.samples.length - 1]!)).toBeLessThan(200);
    expect(Math.abs(cut.samples[Math.round(0.25 * RATE)]!)).toBeGreaterThan(1_000);
  });

  test("a time past the end is the end", () => {
    const wav = { sampleRate: RATE, channels: 1, samples: wavWithTone(0.8, 1.3) };
    expect(cutWav(wav, 1.0, 9).samples.length).toBe(Math.round(0.5 * RATE));
  });
});

describe("the cutter the warm command runs (11.6.3)", () => {
  /** A speech worker that hears the carrier as timed above, and the cut as its own text. */
  function worker(heard: HeardWord[] = HEARD) {
    const asked: string[] = [];
    const stt = {
      transcribeWords: async (wav: string) => { asked.push(wav); return { text: heard.map((w) => w.word).join(" "), words: heard }; },
    };
    return { stt, asked };
  }

  test("it cuts the line's words out of the carrier, from a little before the first to the end of the last", async () => {
    const dir = scratchDir();
    const carrier = join(dir, "carrier.wav");
    await Bun.write(carrier, encodeWav(wavWithTone(0.8, 1.3), RATE));
    const out = join(dir, "cut.wav");
    const { stt, asked } = worker();
    expect(await clipCutter(stt)(carrier, "Stopped.", out)).toBe(true);
    expect(asked).toEqual([carrier]);
    const cut = decodeWav(await Bun.file(out).bytes());
    // "has" runs straight into "stopped", so the cut starts at the boundary the worker heard,
    // and the line ends the carrier, so the cut runs to the end of the file
    expect(cut.samples.length).toBe(Math.round((1.5 - 0.8) * RATE));
    const sound = soundSpan(cut.samples);
    expect(sound.from).toBeLessThan(0.02);
    expect(sound.to).toBeCloseTo(0.5, 1);
  });

  test("with a pause before the line the cut takes a little of the pause, and not the word before", async () => {
    const dir = scratchDir();
    const carrier = join(dir, "carrier.wav");
    await Bun.write(carrier, encodeWav(wavWithTone(0.9, 1.3), RATE));
    const out = join(dir, "cut.wav");
    const paused: HeardWord[] = [{ word: "over.", start: 0.1, end: 0.5 }, { word: "Stopped.", start: 0.9, end: 1.3 }];
    expect(await clipCutter(worker(paused).stt)(carrier, "Stopped.", out)).toBe(true);
    const cut = decodeWav(await Bun.file(out).bytes());
    const lead = 1.5 - cut.samples.length / RATE;
    expect(lead).toBeGreaterThan(0.5);
    expect(lead).toBeLessThan(0.9);
    expect(soundSpan(cut.samples).from).toBeCloseTo(0.9 - lead, 2);
  });

  test("a carrier take in which the line was not heard is refused, and nothing is written", async () => {
    const dir = scratchDir();
    const carrier = join(dir, "carrier.wav");
    await Bun.write(carrier, encodeWav(wavWithTone(0.8, 1.3), RATE));
    const out = join(dir, "cut.wav");
    const garbled: HeardWord[] = [{ word: "The", start: 0.1, end: 0.3 }, { word: "answer", start: 0.3, end: 0.6 }, { word: "hasped.", start: 0.6, end: 1.3 }];
    expect(await clipCutter(worker(garbled).stt)(carrier, "Stopped.", out)).toBe(false);
    expect(await Bun.file(out).exists()).toBe(false);
  });
});

describe("the carriers (11.6.3)", () => {
  test("every carrier is a sentence that ends with the line's own words", () => {
    const words = (line: string) => line.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
    for (const [line, carrier] of Object.entries(CARRIERS)) {
      expect(keptLines(DEFAULTS).lines.includes(line)).toBe(true);
      const own = words(line);
      const said = words(carrier);
      expect(said.length).toBeGreaterThan(own.length);
      expect(said.slice(-own.length)).toEqual(own);
      expect(carrier.endsWith(".")).toBe(true);
    }
  });

  test("every line of one or two words has a carrier", () => {
    for (const line of KEPT_LINES) {
      if (line.split(" ").length <= 2) expect(CARRIERS[line]).toBeDefined();
    }
  });

  test("11.6.5 every default opener is a kept line of one to three words, with a carrier", () => {
    const lines = keptLines(DEFAULTS).lines;
    for (const opener of DEFAULTS.openers) {
      expect(lines).toContain(opener);
      expect(opener.split(" ").length).toBeLessThanOrEqual(3);
      expect(CARRIERS[opener]).toBeDefined();
    }
  });

  test("11.6.5 the openers in the file are kept lines, and the fixed replies stay", () => {
    const lines = keptLines({ ...DEFAULTS, openers: ["Very well."] }).lines;
    expect(lines).toContain("Very well.");
    expect(lines).not.toContain("Okay.");
    for (const line of KEPT_LINES) expect(lines).toContain(line);
  });

  test("the kept lines the bridge really uses carry the tries and the carriers", () => {
    const kept = keptLines(DEFAULTS);
    expect(kept.tries).toBe(DEFAULTS.warmTries);
    expect(kept.carrier?.("Stopped.")).toBe(CARRIERS["Stopped."]!);
    expect(kept.carrier?.("We have not started yet.")).toBeNull();
  });
});
