import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeWav } from "../src/audio.ts";
import { DEFAULTS } from "../src/config.ts";
import { ENGINES, LocalVoice, LocalWhisper } from "../src/speech.ts";

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

// a kokoro test names a kokoro voice; the default engine is the cloning one
const kokoroConfig = { ...DEFAULTS, ttsEngine: "kokoro" as const, ...ENGINES.kokoro.voices };

let tts: LocalVoice;
let stt: LocalWhisper;
let scratch = "";
let firstSentenceMs = 0;
let spoken = "";

beforeAll(async () => {
  if (!run) return;
  scratch = mkdtempSync(join(tmpdir(), "smoke-"));
  tts = new LocalVoice(ENGINES.kokoro, kokoroConfig, speechDir);
  stt = new LocalWhisper(DEFAULTS, speechDir);
  await Promise.all([tts.start(), stt.start()]);
  const at = Date.now();
  spoken = await tts.synthesize(SENTENCE, join(scratch, "said.wav"));
  firstSentenceMs = Date.now() - at;
}, 180_000);

afterAll(() => { if (run) { tts?.stop(); stt?.stop(); } });

describe.skipIf(!run)("the voice, on the card (4.9)", () => {
  test("onnxruntime took the graph on the GPU, and did not quietly fall back", () => {
    expect(tts.ready.provider).toBe("CUDAExecutionProvider");
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

/**
 * The cloning voice (4.9), which is the default since the two OpenSLR
 * speakers were chosen. Its silent failure is the device: without CUDA the
 * model still loads, still speaks, and costs minutes a sentence instead of
 * three seconds. Nobody chases that to its cause either, so it is asserted.
 */
const refsPresent = existsSync(join(DEFAULTS.chatterboxRefs, `${DEFAULTS.ttsVoice}.wav`))
  && existsSync(DEFAULTS.chatterboxPythonBin);
// it shares the transcriber with the block above, so it runs when that one does
const runClone = run && refsPresent;
if (asked && !refsPresent) console.log(`speech smoke: ${DEFAULTS.chatterboxRefs} or its environment is absent`);

describe.skipIf(!runClone)("the cloning voice, on the card (4.9)", () => {
  let clone: LocalVoice;
  let cloneScratch = "";
  let saidMale = "";
  let sentenceMs = 0;

  beforeAll(async () => {
    cloneScratch = mkdtempSync(join(tmpdir(), "clone-"));
    clone = new LocalVoice(ENGINES.chatterbox, DEFAULTS, speechDir);
    await clone.start();
    const at = Date.now();
    saidMale = await clone.synthesize(SENTENCE, join(cloneScratch, "male.wav"));
    sentenceMs = Date.now() - at;
  }, 300_000);

  afterAll(() => clone?.stop());

  test("it took the model on the GPU, and did not quietly fall back to the CPU", () => {
    expect(clone.ready.device).toBe("cuda");
  });

  test("it speaks at the rate the transport expects", () => {
    expect(clone.sampleRate).toBe(24_000);
  });

  test("a sentence costs seconds, not the tenths kokoro costs", () => {
    // measured at 2.9 to 3.2 seconds; this is twenty times kokoro and it is
    // the price of the voice, so the guard is an order of magnitude, not a
    // target. Minutes here means the CPU took it.
    expect(sentenceMs).toBeGreaterThan(300);
    expect(sentenceMs).toBeLessThan(15_000);
  });

  test("9.4 switches to the other voice, and the words survive the switch", async () => {
    clone.use(DEFAULTS.voiceChoices.female);
    const saidFemale = await clone.synthesize(SENTENCE, join(cloneScratch, "female.wav"));
    const male = decodeWav(await Bun.file(saidMale).bytes());
    const female = decodeWav(await Bun.file(saidFemale).bytes());
    expect(male.samples.length).toBeGreaterThan(0);
    expect(female.samples.length).toBeGreaterThan(0);
    // this voice reads "barge in" as "barging", so the round trip is checked on
    // words neither engine reshapes
    const heard = (await stt.transcribe(saidFemale)).toLowerCase();
    for (const word of ["detector", "tolerates", "syllables"]) expect(heard).toContain(word);
  }, 120_000);
});
