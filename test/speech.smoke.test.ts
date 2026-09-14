import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeWav } from "../src/audio.ts";
import { DEFAULTS } from "../src/config.ts";
import { LocalKokoro, LocalWhisper } from "../src/speech.ts";

/**
 * The engines, against the real models on the real card.
 *
 * This is not in the default run: it wants a GPU, two virtual environments and
 * about a gigabyte of model, and it takes ten seconds. Ask for it by name:
 *
 *   VOICE_BRIDGE_GPU=1 bun test speech.smoke
 *
 * The assertion that earns its place is the provider. onnxruntime without its
 * CUDA libraries does not fail: it takes the graph on the CPU, returns a
 * working session, and every sentence costs a second instead of a tenth. The
 * only symptom is that the bridge feels slow, which is not a symptom anybody
 * chases to its cause.
 *
 * The rest is a round trip. The voice says a sentence, the transcriber reads it
 * back, and the two have to agree -- so neither can rot quietly while the other
 * covers for it.
 */
const SENTENCE = "The barge in detector now tolerates a dip between syllables.";
const speechDir = new URL("../speech", import.meta.url).pathname;
const asked = process.env.VOICE_BRIDGE_GPU === "1";
const present = existsSync(DEFAULTS.kokoroModel) && existsSync(DEFAULTS.kokoroPythonBin);
const run = asked && present;
if (asked && !present) console.log(`speech smoke: ${DEFAULTS.kokoroModel} or its environment is absent`);

let tts: LocalKokoro;
let stt: LocalWhisper;
let scratch = "";
let firstSentenceMs = 0;
let spoken = "";

beforeAll(async () => {
  if (!run) return;
  scratch = mkdtempSync(join(tmpdir(), "smoke-"));
  tts = new LocalKokoro(DEFAULTS, speechDir);
  stt = new LocalWhisper(DEFAULTS, speechDir);
  await Promise.all([tts.start(), stt.start()]);
  const at = Date.now();
  spoken = await tts.synthesize(SENTENCE, join(scratch, "said.wav"));
  firstSentenceMs = Date.now() - at;
}, 180_000);

afterAll(() => { if (run) { tts?.stop(); stt?.stop(); } });

describe.skipIf(!run)("the voice, on the card (4.9)", () => {
  test("onnxruntime took the graph on the GPU, and did not quietly fall back", () => {
    expect(tts.provider).toBe("CUDAExecutionProvider");
  });

  test("it speaks at the rate the transport expects", () => {
    expect(tts.sampleRate).toBe(24_000);
  });

  test("a sentence is audio, not an empty file", async () => {
    const wav = decodeWav(await Bun.file(spoken).bytes());
    const seconds = wav.samples.length / wav.sampleRate;
    expect(seconds).toBeGreaterThan(1);
    expect(seconds).toBeLessThan(15);
    let peak = 0;
    for (const sample of wav.samples) peak = Math.max(peak, Math.abs(sample));
    expect(peak).toBeGreaterThan(1_000);
  });

  test("the first sentence of an answer is not something Chris waits for", () => {
    // measured at 120 to 165 ms; this guards the order of magnitude, and a
    // fallback to the CPU lands at about a second
    expect(firstSentenceMs).toBeLessThan(500);
  });
});

describe.skipIf(!run)("the transcriber, on the card (4.6)", () => {
  test("it reads back what the voice just said", async () => {
    const heard = (await stt.transcribe(spoken)).toLowerCase();
    // not word for word: the engine writes "barge in" and "barge-in" both ways
    for (const word of ["barge", "detector", "syllables"]) expect(heard).toContain(word);
  }, 60_000);

  test("silence transcribes as nothing, so a quiet car costs no turns", async () => {
    const quiet = join(scratch, "quiet.wav");
    await Bun.spawn(["sox", "-n", "-r", "16000", "-c", "1", "-b", "16", "-e", "signed-integer", quiet, "trim", "0.0", "2.0"]).exited;
    expect(await stt.transcribe(quiet)).toBe("");
  }, 60_000);
});
