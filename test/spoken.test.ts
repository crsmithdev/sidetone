import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config.ts";
import { KEPT_LINES, keptLines } from "../src/conversation.ts";
import { SpokenAhead, type TextToSpeech } from "../src/speech.ts";

/** A voice that writes a file and counts how often it was asked to (11.6). */
function engine(voice = "male") {
  const asked: string[] = [];
  const tts: TextToSpeech = {
    start: async () => {},
    sampleRate: 24_000,
    voice,
    synthesize: async (text: string, wav: string) => {
      asked.push(text);
      await Bun.write(wav, text);
      return wav;
    },
    stop: () => {},
  };
  return { tts, asked };
}

const scratchDir = () => mkdtempSync(join(tmpdir(), "spoken-"));

describe("the sentences the bridge keeps (11.6)", () => {
  test("a kept line is made once and never again, in this run or the next", async () => {
    const dir = scratchDir();
    const kept = { dir, signature: "test", lines: KEPT_LINES };
    const first = engine();
    await new SpokenAhead(first.tts, scratchDir(), kept).take("Muted.");
    expect(first.asked).toEqual(["Muted."]);

    // a second run, with its own scratch: the sentence is on disk, so nothing is asked
    const second = engine();
    const wav = await new SpokenAhead(second.tts, scratchDir(), kept).take("Muted.");
    expect(second.asked).toEqual([]);
    expect(existsSync(wav)).toBe(true);
  });

  test("a sentence of the answer is never kept, because there is no end to those", async () => {
    const dir = scratchDir();
    const { tts, asked } = engine();
    const ahead = new SpokenAhead(tts, scratchDir(), { dir, signature: "test", lines: KEPT_LINES });
    const wav = await ahead.take("The tests pass and the config is committed.");
    expect(wav.startsWith(dir)).toBe(false);
    expect(asked.length).toBe(1);
  });

  test("the other voice does not get this voice's sentences", async () => {
    const dir = scratchDir();
    const kept = { dir, signature: "test", lines: KEPT_LINES };
    const male = engine("som_00295");
    await new SpokenAhead(male.tts, scratchDir(), kept).take("Muted.");
    const female = engine("sof_01208");
    await new SpokenAhead(female.tts, scratchDir(), kept).take("Muted.");
    // 9.4 switching voice must change what is heard, not only what is said
    expect(female.asked).toEqual(["Muted."]);
  });

  test("a setting that changes how a voice sounds changes what is kept", async () => {
    const dir = scratchDir();
    const plain = engine();
    await new SpokenAhead(plain.tts, scratchDir(), { dir, signature: "chatterbox-0.5-0.5", lines: KEPT_LINES }).take("Muted.");
    const lively = engine();
    await new SpokenAhead(lively.tts, scratchDir(), { dir, signature: "chatterbox-0.8-0.3", lines: KEPT_LINES }).take("Muted.");
    expect(lively.asked).toEqual(["Muted."]);
  });

  test("warm makes every line that is missing, and makes none of them twice", async () => {
    const dir = scratchDir();
    const kept = { dir, signature: "test", lines: KEPT_LINES };
    const first = engine();
    expect(await new SpokenAhead(first.tts, scratchDir(), kept).warm()).toBe(KEPT_LINES.length);
    const second = engine();
    expect(await new SpokenAhead(second.tts, scratchDir(), kept).warm()).toBe(0);
    expect(second.asked).toEqual([]);
  });

  test("with nowhere to keep them, every sentence is made the old way", async () => {
    const { tts, asked } = engine();
    const ahead = new SpokenAhead(tts, scratchDir());
    await ahead.take("Muted.");
    await ahead.take("Muted.");
    expect(asked).toEqual(["Muted.", "Muted."]);
  });

  test("the key the bridge really uses holds the engine and both voice settings", () => {
    const key = keptLines(DEFAULTS);
    expect(key.signature).toContain(DEFAULTS.ttsEngine);
    expect(key.signature).toContain(String(DEFAULTS.chatterboxExaggeration));
    expect(key.dir).toBe(DEFAULTS.spokenDir);
  });
});
