import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav } from "../src/audio.ts";
import { DEFAULTS } from "../src/config.ts";
import { SentClips, checkClip, clipChecker } from "../src/sent.ts";
import { SpokenAhead, type TextToSpeech } from "../src/speech.ts";

const scratchDir = () => mkdtempSync(join(tmpdir(), "sent-"));

/** A wav on disk that holds its own text, so a copy can be told from another. */
async function wavOf(text: string): Promise<string> {
  const path = join(scratchDir(), "say.wav");
  await Bun.write(path, text);
  return path;
}

describe("the clips the bridge sent (18.14)", () => {
  test("a clip is kept with its text, its time and where it came from", async () => {
    const sent = new SentClips(scratchDir(), 5);
    sent.keep(await wavOf("muted"), "Muted.", "kept", 1_000);
    const [clip] = sent.list();
    expect(clip).toMatchObject({ text: "Muted.", at: 1_000, source: "kept" });
    expect(await Bun.file(clip!.wav).text()).toBe("muted");
  });

  test("the newest comes first", async () => {
    const sent = new SentClips(scratchDir(), 5);
    sent.keep(await wavOf("a"), "One.", "made", 1_000);
    sent.keep(await wavOf("b"), "Two.", "made", 2_000);
    sent.keep(await wavOf("c"), "Three.", "made", 2_000);
    expect(sent.list().map((clip) => clip.text)).toEqual(["Three.", "Two.", "One."]);
  });

  test("past the limit the oldest goes first, wav and text together", async () => {
    const dir = scratchDir();
    const sent = new SentClips(dir, 3);
    for (let i = 1; i <= 5; i++) sent.keep(await wavOf(`${i}`), `Sentence ${i}.`, "made", i * 1_000);
    expect(sent.list().map((clip) => clip.text)).toEqual(["Sentence 5.", "Sentence 4.", "Sentence 3."]);
    // nothing of the two that went is left behind
    expect(readdirSync(dir).length).toBe(6);
  });

  test("a second run finds the clips of the first and keeps to the same limit", async () => {
    const dir = scratchDir();
    const first = new SentClips(dir, 2);
    first.keep(await wavOf("a"), "One.", "made", 1_000);
    first.keep(await wavOf("b"), "Two.", "made", 2_000);
    const second = new SentClips(dir, 2);
    second.keep(await wavOf("c"), "Three.", "made", 3_000);
    expect(second.list().map((clip) => clip.text)).toEqual(["Three.", "Two."]);
  });

  test("the copy outlives the scratch wav it was taken from", async () => {
    const sent = new SentClips(scratchDir(), 5);
    const wav = await wavOf("fresh");
    sent.keep(wav, "Fresh.", "made", 1_000);
    await Bun.file(wav).delete();
    expect(existsSync(sent.list()[0]!.wav)).toBe(true);
  });

  test("the setting is on, and the clips go under ~/.sidetone/sent", () => {
    expect(DEFAULTS.keepSentClips).toBe(true);
    expect(DEFAULTS.sentDir.endsWith(join(".sidetone", "sent"))).toBe(true);
  });
});

/** A voice that writes the text as the wav, so a copy names what it holds. */
function engine() {
  const tts: TextToSpeech = {
    start: async () => {},
    sampleRate: 24_000,
    switchable: false,
    voice: "som_00295",
    use: () => {},
    synthesize: async (text: string, wav: string) => { await Bun.write(wav, text); return wav; },
    stop: () => {},
  };
  return tts;
}

describe("what the mouth takes is what is kept (18.14)", () => {
  test("a sentence made now is kept as made", async () => {
    const sent = new SentClips(scratchDir(), 5);
    await new SpokenAhead(engine(), scratchDir(), undefined, sent).take("The tests pass.");
    expect(sent.list()).toMatchObject([{ text: "The tests pass.", source: "made" }]);
  });

  test("a kept line played from disk is kept as kept", async () => {
    const kept = { dir: scratchDir(), signature: "test", lines: ["Muted."] };
    await new SpokenAhead(engine(), scratchDir(), kept).take("Muted.");
    const sent = new SentClips(scratchDir(), 5);
    await new SpokenAhead(engine(), scratchDir(), kept, sent).take("Muted.");
    expect(sent.list()).toMatchObject([{ text: "Muted.", source: "kept" }]);
  });

  test("a sentence made ahead is kept once it is taken, not before", async () => {
    const sent = new SentClips(scratchDir(), 5);
    const ahead = new SpokenAhead(engine(), scratchDir(), undefined, sent);
    ahead.start("The next one.");
    await Bun.sleep(5);
    expect(sent.list()).toEqual([]);
    await ahead.take("The next one.");
    expect(sent.list()).toMatchObject([{ text: "The next one.", source: "made" }]);
  });

  test("with no store nothing is kept", async () => {
    const wav = await new SpokenAhead(engine(), scratchDir()).take("Nothing kept.");
    expect(existsSync(wav)).toBe(true);
  });
});

/** Half a second of a tone at `peak` of full scale. */
function tone(peak: number, sampleRate = 24_000, channels = 1): Uint8Array {
  const samples = new Int16Array(sampleRate / 2 * channels);
  for (let i = 0; i < samples.length; i++) samples[i] = Math.round(Math.sin(i / 5) * peak * 32767);
  return encodeWav(samples, sampleRate, channels);
}

describe("the check of a sent clip (18.14.2)", () => {
  test("it reports the length, the rate, the channels and the peak", () => {
    const check = checkClip(tone(0.5), "Muted.", "Muted.");
    expect(check.ms).toBe(500);
    expect(check.sampleRate).toBe(24_000);
    expect(check.channels).toBe(1);
    expect(check.peak).toBeCloseTo(0.5, 2);
  });

  test("the length counts frames, not samples, when there are two channels", () => {
    expect(checkClip(tone(0.5, 24_000, 2), "Muted.", "Muted.").ms).toBe(500);
  });

  test("a transcription that matches the text is clean", () => {
    const check = checkClip(tone(0.5), "The tests pass and the config is committed.", "The tests pass, and the config is committed.");
    expect(check.likeness).toBe(1);
    expect(check.garbled).toBe(false);
  });

  test("a transcription with nothing in it is garbled", () => {
    expect(checkClip(tone(0.5), "Muted.", "").garbled).toBe(true);
  });

  test("a transcription that loses most of the text is garbled", () => {
    expect(checkClip(tone(0.5), "Listening.", "Lis.").garbled).toBe(true);
  });

  test("a transcription that repeats a part many times is garbled", () => {
    // item 33c: the voice said ".ts" about twelve times in a row
    const text = "I changed src/sentences.ts.";
    const heard = "I changed src/sentences.ts. ts. ts. ts. ts. ts. ts. ts. ts. ts. ts. ts.";
    expect(checkClip(tone(0.5), text, heard).garbled).toBe(true);
  });

  test("a transcription in the wrong order is garbled", () => {
    // item 33b: Chris heard the sounds of "Listening." in the wrong order
    expect(checkClip(tone(0.5), "Listening.", "Ning list en.").garbled).toBe(true);
  });
});

describe("the check the bridge runs on a kept line (11.6.1)", () => {
  test("it transcribes the wav and says whether the words match the text", async () => {
    const wav = join(scratchDir(), "muted.wav");
    await Bun.write(wav, tone(0.5));
    const heard = ["I'm gonna kill Tevrazigan!", "Muted."];
    const check = clipChecker({ transcribe: async () => heard.shift()! });
    expect(await check(wav, "Muted.")).toBe(false);
    expect(await check(wav, "Muted.")).toBe(true);
  });
});
