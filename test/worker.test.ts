import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, type Config } from "../src/config.ts";
import { LocalWhisper, SmartTurn } from "../src/speech.ts";

/**
 * The protocol every engine speaks, with no model and no GPU: a stub worker
 * that imports the real `speech/worker.py` and answers as the test asks.
 * `speech.smoke` checks the real engines, but only by hand with the card.
 */
const PYTHON = Bun.which("python3");
const speechDir = new URL("../speech", import.meta.url).pathname;

/** The stub answers by the file it is asked to read. */
const STUB = `
import sys
sys.path.insert(0, ${JSON.stringify(speechDir)})
import worker

if sys.argv[1] == "refuse":
    worker.reply(ready=False, error="no model")
    sys.exit(0)

def handle(request):
    if "pcm" in request:
        return {"probability": 0.75, "inference_ms": 12}
    wav = request["wav"]
    if wav == "raise":
        raise ValueError("no such file")
    if wav == "print":
        # a library that writes to stdout uninvited, as the chatterbox watermarker does
        print("loaded PerthNet (Implicit) at step 250,000")
        return {"text": "after the noise"}
    if wav == "garble":
        worker.PROTOCOL.write("loaded something\\n")
        worker.PROTOCOL.flush()
        sys.exit(0)
    if wav == "die":
        sys.exit(1)
    words = [{"word": "hello", "start": 0.0, "end": 0.4}] if request.get("words") else None
    return {"text": "heard " + wav, **({"words": words} if words else {})}

worker.reply(ready=True, warmup_seconds=1.5, load_seconds=0.25)
worker.serve(handle)
`;

const scripts = mkdtempSync(join(tmpdir(), "worker-"));
writeFileSync(join(scripts, "stt_worker.py"), STUB);
writeFileSync(join(scripts, "turn_worker.py"), STUB);

const config = (overrides: Partial<Config> = {}): Config => ({ ...DEFAULTS, pythonBin: PYTHON ?? "", ...overrides } as Config);

const started: Array<{ stop(): void }> = [];
afterEach(() => { while (started.length) started.pop()?.stop(); });

async function whisper(overrides: Partial<Config> = {}): Promise<LocalWhisper> {
  const stt = new LocalWhisper(config(overrides), scripts);
  started.push(stt);
  await stt.start();
  return stt;
}

describe.skipIf(!PYTHON)("the worker protocol (4.6, 4.9)", () => {
  test("the ready line starts it, and says what the warmup cost", async () => {
    const stt = await whisper();
    expect(stt.warmupSeconds).toBe(1.5);
  });

  test("a worker that is not ready does not start, and says why", async () => {
    const stt = new LocalWhisper(config({ sttModel: "refuse" }), scripts);
    started.push(stt);
    await expect(stt.start()).rejects.toThrow('did not start: {"ready":false,"error":"no model"}');
  });

  test("the replies come back in the order of the requests", async () => {
    const stt = await whisper();
    const texts = await Promise.all(["one.wav", "two.wav", "three.wav"].map((wav) => stt.transcribe(wav)));
    expect(texts).toEqual(["heard one.wav", "heard two.wav", "heard three.wav"]);
    expect(await stt.transcribeWords("four.wav")).toEqual({ text: "heard four.wav", words: [{ word: "hello", start: 0, end: 0.4 }] });
  });

  test("a request that fails is an error, and the worker goes on", async () => {
    const stt = await whisper();
    await expect(stt.transcribe("raise")).rejects.toThrow("no such file");
    expect(await stt.transcribe("after.wav")).toBe("heard after.wav");
  });

  test("what a library prints does not reach the protocol", async () => {
    const stt = await whisper();
    expect(await stt.transcribe("print")).toBe("after the noise");
    expect(await stt.transcribe("after.wav")).toBe("heard after.wav");
  });

  test("a line that is not JSON is an error that says the line", async () => {
    const stt = await whisper();
    await expect(stt.transcribe("garble")).rejects.toThrow("the worker said something that is not JSON: loaded something");
  });

  test("a worker that dies in a request fails it, and every request after it", async () => {
    const stt = await whisper();
    const failed = (reply: Promise<string>) => reply.then(() => "", (error: Error) => error.message);
    const both = await Promise.all([failed(stt.transcribe("die")), failed(stt.transcribe("behind.wav"))]);
    expect(both).toEqual(["the worker stopped", "the worker stopped"]);
  });

  test("a stopped worker takes no request", async () => {
    const stt = await whisper();
    stt.stop();
    await expect(stt.transcribe("late.wav")).rejects.toThrow("the worker is not running");
  });

  test("the turn detector reads its load time and its score from the same protocol (18.16)", async () => {
    const turn = new SmartTurn(config(), scripts);
    started.push(turn);
    await turn.start();
    expect(turn.loadSeconds).toBe(0.25);
    expect(await turn.score(new Int16Array(1_600), 16_000)).toEqual({ probability: 0.75, inferenceMs: 12 });
  });
});
