import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS } from "../src/config.ts";
import { KEPT_LINES, keptLines } from "../src/mouth.ts";
import { SpokenAhead, type TextToSpeech } from "../src/speech.ts";

/** A voice that writes a file and counts how often it was asked to (11.6). */
function engine(voice = "male", switchable = true) {
  const asked: string[] = [];
  const tts: TextToSpeech = {
    start: async () => {},
    sampleRate: 24_000,
    switchable,
    get voice() { return voice; },
    use: (next: string) => { if (switchable) voice = next; },
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

  test("the key the bridge really uses holds the engine and its own voice settings", () => {
    const key = keptLines(DEFAULTS);
    expect(key.signature).toContain(DEFAULTS.ttsEngine);
    expect(key.signature).toContain(String(DEFAULTS.chatterboxExaggeration));
    expect(key.dir).toBe(DEFAULTS.spokenDir);
    // another engine's settings do not stamp this engine's key
    expect(keptLines({ ...DEFAULTS, ttsEngine: "kokoro" }).signature).toBe("kokoro");
  });

  test("a sentence's wav goes once the next one is taken; a kept line stays", async () => {
    const dir = scratchDir();
    const { tts } = engine();
    const ahead = new SpokenAhead(tts, scratchDir(), { dir, signature: "test", lines: KEPT_LINES });
    const first = await ahead.take("The first sentence of the answer.");
    expect(existsSync(first)).toBe(true);
    const kept = await ahead.take("Muted.");
    expect(existsSync(first)).toBe(false);
    await ahead.take("The next sentence.");
    expect(existsSync(kept)).toBe(true);
  });

  test("a sentence made ahead that never plays is removed too", async () => {
    const { tts } = engine();
    const ahead = new SpokenAhead(tts, scratchDir());
    ahead.start("one.");
    ahead.start("two.");   // "one." was made ahead and is now not next
    const two = await ahead.take("two.");
    await new Promise((resolve) => setTimeout(resolve, 10));
    const scratch = two.slice(0, two.lastIndexOf("/"));
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(scratch)).toEqual([two.slice(scratch.length + 1)]);
  });
});

describe("a switch of voice (9.4)", () => {
  test("the sentence made ahead was in the old voice, so it is made again", async () => {
    const { tts, asked } = engine("female");
    const ahead = new SpokenAhead(tts, scratchDir());
    ahead.start("Four.");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(ahead.use("male")).toBe(true);
    await ahead.take("Four.");
    expect(asked).toEqual(["Four.", "Four."]);
    expect(tts.voice).toBe("male");
  });

  test("an engine of one voice says no, and keeps its voice", () => {
    const { tts } = engine("only", false);
    expect(new SpokenAhead(tts, scratchDir()).use("male")).toBe(false);
    expect(tts.voice).toBe("only");
  });
});

/**
 * A check that says the next answers in `verdicts`, then clean. It stands in
 * for the speech worker, which is what the bridge checks a kept line with.
 */
function checker(...verdicts: boolean[]) {
  const checked: string[] = [];
  const check = async (_wav: string, text: string) => { checked.push(text); return verdicts.shift() ?? true; };
  return { check, checked };
}

describe("a kept line is checked before it is kept (11.6.1)", () => {
  test("a line the check refuses still plays, is not kept, and is made again next time", async () => {
    const dir = scratchDir();
    const { tts, asked } = engine();
    const ahead = new SpokenAhead(tts, scratchDir(), { dir, signature: "test", lines: KEPT_LINES, check: checker(false).check });
    const garbled = await ahead.take("Muted.");
    expect(existsSync(garbled)).toBe(true);
    expect(garbled.startsWith(dir)).toBe(false);
    const clean = await ahead.take("Muted.");
    expect(asked).toEqual(["Muted.", "Muted."]);
    expect(clean.startsWith(dir)).toBe(true);
    // the refused take was scratch, so it goes once the next one is taken
    expect(existsSync(garbled)).toBe(false);
  });

  test("warm checks a line already kept, and makes it again when the check refuses it", async () => {
    const dir = scratchDir();
    const kept = { dir, signature: "test", lines: ["Muted.", "Listening."], tries: 3 };
    await new SpokenAhead(engine().tts, scratchDir(), kept).warm();
    const { tts, asked } = engine();
    // the kept "Muted." is garbled; the first new take of it is too, the second is clean
    const { check } = checker(false, false, true, true);
    const said: string[] = [];
    const made = await new SpokenAhead(tts, scratchDir(), { ...kept, check }).warm((text, outcome, takes) => said.push(`${outcome} ${text} in ${takes}`));
    expect(asked).toEqual(["Muted.", "Muted."]);
    expect(made).toBe(1);
    expect(said).toEqual(["made Muted. in 2", "kept Listening. in 0"]);
  });

  test("warm gives up on a line after the set number of tries, and says so", async () => {
    const dir = scratchDir();
    const { tts, asked } = engine();
    const { check } = checker(...new Array<boolean>(100).fill(false));
    const said: string[] = [];
    const ahead = new SpokenAhead(tts, scratchDir(), { dir, signature: "test", lines: ["Muted."], check, tries: 7 });
    expect(await ahead.warm((text, outcome) => said.push(`${outcome} ${text}`))).toBe(0);
    expect(asked.length).toBe(7);
    expect(said).toEqual(["garbled Muted."]);
    expect(existsSync(join(dir, "test-male", "muted.wav"))).toBe(false);
  });

  test("the number of tries is a setting, and the default is what the bridge warms with", () => {
    expect(DEFAULTS.warmTries).toBe(100);
    expect(keptLines(DEFAULTS).tries).toBe(DEFAULTS.warmTries);
  });

  test("with no number of tries a line is made once", async () => {
    const { tts, asked } = engine();
    const { check } = checker(false, false);
    await new SpokenAhead(tts, scratchDir(), { dir: scratchDir(), signature: "test", lines: ["Muted."], check }).warm();
    expect(asked).toEqual(["Muted."]);
  });
});

/**
 * A cutter that writes the cut as the line's text, and says whether the
 * carrier take held the line. It stands in for the speech worker's timed
 * transcription and the cut made from it.
 */
function cutter(...found: boolean[]) {
  const cuts: string[] = [];
  const cut = async (carrierWav: string, text: string, out: string) => {
    cuts.push(`${await Bun.file(carrierWav).text()} -> ${text}`);
    const ok = found.shift() ?? true;
    if (ok) await Bun.write(out, text);
    return ok;
  };
  return { cut, cuts };
}

describe("a line the voice never says alone is cut out of a carrier (11.6.3)", () => {
  const carrier = (text: string) => text === "Stopped." ? "The answer has stopped." : null;

  test("after the tries the line is made inside its carrier, cut out, checked, and kept", async () => {
    const dir = scratchDir();
    const { tts, asked } = engine();
    // three takes alone, all garbled; the cut is clean
    const { check, checked } = checker(false, false, false, true);
    const { cut, cuts } = cutter();
    const said: string[] = [];
    const kept = { dir, signature: "test", lines: ["Stopped."], check, tries: 3, carrier, cut };
    expect(await new SpokenAhead(tts, scratchDir(), kept).warm((text, outcome) => said.push(`${outcome} ${text}`))).toBe(1);
    expect(asked).toEqual(["Stopped.", "Stopped.", "Stopped.", "The answer has stopped."]);
    expect(cuts).toEqual(["The answer has stopped. -> Stopped."]);
    // the cut clip passes the same check as any take, against the line's own text
    expect(checked).toEqual(["Stopped.", "Stopped.", "Stopped.", "Stopped."]);
    expect(said).toEqual(["carried Stopped."]);
    const path = join(dir, "test-male", "stopped.wav");
    expect(await Bun.file(path).text()).toBe("Stopped.");
    // the next run finds it and asks for nothing
    const next = engine();
    await new SpokenAhead(next.tts, scratchDir(), kept).warm();
    expect(next.asked).toEqual([]);
  });

  test("a cut the check refuses is not kept, and the carrier is tried again", async () => {
    const dir = scratchDir();
    const { tts, asked } = engine();
    const { check } = checker(false, false, false, false, true);
    const { cut } = cutter(false, true, true);
    const kept = { dir, signature: "test", lines: ["Stopped."], check, tries: 3, carrier, cut };
    const said: string[] = [];
    expect(await new SpokenAhead(tts, scratchDir(), kept).warm((text, outcome, takes) => said.push(`${outcome} ${text} in ${takes}`))).toBe(1);
    // three takes alone, then a carrier the line was not heard in, then a cut the check refused, then a clean one
    expect(asked).toEqual(["Stopped.", "Stopped.", "Stopped.", "The answer has stopped.", "The answer has stopped.", "The answer has stopped."]);
    expect(said).toEqual(["carried Stopped. in 6"]);
  });

  test("the carrier gets the same number of tries, and then the line is garbled", async () => {
    const dir = scratchDir();
    const { tts, asked } = engine();
    const { check } = checker(...new Array<boolean>(100).fill(false));
    const { cut } = cutter();
    const kept = { dir, signature: "test", lines: ["Stopped."], check, tries: 4, carrier, cut };
    const said: string[] = [];
    expect(await new SpokenAhead(tts, scratchDir(), kept).warm((text, outcome) => said.push(`${outcome} ${text}`))).toBe(0);
    expect(asked.length).toBe(8);
    expect(said).toEqual(["garbled Stopped."]);
    expect(existsSync(join(dir, "test-male", "stopped.wav"))).toBe(false);
    // nothing of the carrier takes or the cuts is left in the scratch
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(dir + "/..").filter((name) => name.startsWith("say-"))).toEqual([]);
  });

  test("a line with no carrier is garbled as before", async () => {
    const { tts, asked } = engine();
    const { check } = checker(false, false);
    const { cut, cuts } = cutter();
    const kept = { dir: scratchDir(), signature: "test", lines: ["Muted."], check, tries: 2, carrier, cut };
    const said: string[] = [];
    await new SpokenAhead(tts, scratchDir(), kept).warm((text, outcome) => said.push(`${outcome} ${text}`));
    expect(asked).toEqual(["Muted.", "Muted."]);
    expect(cuts).toEqual([]);
    expect(said).toEqual(["garbled Muted."]);
  });

  test("a carrier take that is clean is never kept as the line: only its cut is", async () => {
    const dir = scratchDir();
    const { tts } = engine();
    const { check } = checker(false, true);
    const { cut } = cutter(true);
    const kept = { dir, signature: "test", lines: ["Stopped."], check, tries: 1, carrier, cut };
    await new SpokenAhead(tts, scratchDir(), kept).warm();
    expect(await Bun.file(join(dir, "test-male", "stopped.wav")).text()).toBe("Stopped.");
  });
});
