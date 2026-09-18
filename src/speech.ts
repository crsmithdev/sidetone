/**
 * The voice engines (spec 4.5-4.9).
 *
 * 4.5 is a constraint, not a default: no part of this path reaches a cloud
 * service, in any mode, at any time. 4.8 says each engine sits behind an
 * interface and that the interface accepts local engines only, so there is no
 * cloud implementation to select and no fallback when a local one fails.
 *
 * Each engine is a long-lived Python worker under speech/. Both cost seconds
 * to load and a fraction of a second to run, so the bridge starts them once
 * and warms them before Chris says anything.
 */
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import type { Config } from "./config.ts";
import { LineSplitter } from "./protocol.ts";

/** 4.8 the seam. A local engine only: there is no cloud engine to put here. */
export interface SpeechToText {
  start(): Promise<void>;
  transcribe(wavPath: string): Promise<string>;
  stop(): void;
}

export interface TextToSpeech {
  start(): Promise<void>;
  /** Non-zero once the engine has answered, which is how the health check knows. */
  readonly sampleRate: number;
  /** Writes the speech to wavPath and returns it. */
  synthesize(text: string, wavPath: string): Promise<string>;
  /** 9.4 change voice without a restart. An engine of one voice leaves this out. */
  use?(voice: string): void;
  stop(): void;
}

/**
 * The CUDA libraries that ship as wheels inside the virtual environment.
 * ctranslate2 wants CUDA 12 and finds nothing on the system path, because the
 * only CUDA on this machine belongs to torch and is CUDA 13.
 */
function cudaLibraryPath(pythonBin: string): string {
  const root = join(dirname(dirname(pythonBin)), "lib");
  const dirs: string[] = [];
  try {
    for (const python of readdirSync(root)) {
      const nvidia = join(root, python, "site-packages", "nvidia");
      if (!existsSync(nvidia)) continue;
      for (const pkg of readdirSync(nvidia)) {
        const lib = join(nvidia, pkg, "lib");
        if (existsSync(lib)) dirs.push(lib);
      }
    }
  } catch { /* no wheels: the worker says so itself */ }
  return dirs.join(":");
}

/** One Python worker: a JSON request a line in, a JSON reply a line out. */
class Worker {
  private child: Subprocess<"pipe", "pipe", "inherit"> | null = null;
  private waiting: Array<(reply: Record<string, unknown>) => void> = [];

  constructor(private readonly bin: string, private readonly args: string[], private readonly env: Record<string, string>) {}

  async start(): Promise<Record<string, unknown>> {
    const ready = this.next();
    this.child = Bun.spawn([this.bin, ...this.args], {
      stdin: "pipe", stdout: "pipe", stderr: "inherit",
      env: { ...process.env, ...this.env },
    }) as Subprocess<"pipe", "pipe", "inherit">;
    void this.pump();
    const first = await ready;
    if (first.ready !== true) throw new Error(`${this.args[0]} did not start: ${JSON.stringify(first)}`);
    return first;
  }

  private async pump(): Promise<void> {
    const child = this.child;
    if (!child) return;
    const splitter = new LineSplitter();
    const decoder = new TextDecoder();
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      for (const line of splitter.push(decoder.decode(chunk, { stream: true }))) {
        const resolve = this.waiting.shift();
        if (!resolve) continue;
        try { resolve(JSON.parse(line) as Record<string, unknown>); }
        catch { resolve({ error: `the worker said something that is not JSON: ${line.slice(0, 120)}` }); }
      }
    }
    while (this.waiting.length) this.waiting.shift()?.({ error: "the worker stopped" });
  }

  private next(): Promise<Record<string, unknown>> {
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async request(value: unknown): Promise<Record<string, unknown>> {
    const stdin = this.child?.stdin;
    if (!stdin) throw new Error("the worker is not running");
    const reply = this.next();
    stdin.write(`${JSON.stringify(value)}\n`);
    stdin.flush();
    const result = await reply;
    if (typeof result.error === "string") throw new Error(result.error);
    return result;
  }

  stop(): void {
    try { this.child?.kill(); } catch { /* already gone */ }
    this.child = null;
  }
}

/** 4.6 a small Whisper-family model, on the GPU, faster than real time. */
export class LocalWhisper implements SpeechToText {
  private worker: Worker;
  /** what the warmup cost, so 18.4 has a number to report */
  warmupSeconds = 0;

  constructor(config: Config, scriptDir: string) {
    this.worker = new Worker(config.pythonBin, [join(scriptDir, "stt_worker.py"), config.sttModel, config.modelsDir],
      { LD_LIBRARY_PATH: cudaLibraryPath(config.pythonBin) });
  }

  async start(): Promise<void> {
    const ready = await this.worker.start();
    this.warmupSeconds = typeof ready.warmup_seconds === "number" ? ready.warmup_seconds : 0;
  }

  async transcribe(wavPath: string): Promise<string> {
    const reply = await this.worker.request({ wav: wavPath });
    return typeof reply.text === "string" ? reply.text : "";
  }

  stop(): void { this.worker.stop(); }
}


/** 4.9 the first working local voice. The voice is a setting; every choice is local. */
export class LocalPiper implements TextToSpeech {
  private worker: Worker;
  sampleRate = 0;

  constructor(config: Config, scriptDir: string) {
    this.worker = new Worker(config.pythonBin, [join(scriptDir, "tts_worker.py"), join(config.modelsDir, `${config.ttsVoice}.onnx`)], {});
  }

  async start(): Promise<void> {
    const ready = await this.worker.start();
    this.sampleRate = typeof ready.sample_rate === "number" ? ready.sample_rate : 0;
  }

  async synthesize(text: string, wavPath: string): Promise<string> {
    const reply = await this.worker.request({ text, wav: wavPath });
    return typeof reply.wav === "string" ? reply.wav : wavPath;
  }

  stop(): void { this.worker.stop(); }
}

/**
 * 4.9 the same job on the GPU, which was idle. All 54 voices share one model,
 * so `use` costs nothing and can happen between two sentences.
 */
export class LocalKokoro implements TextToSpeech {
  private worker: Worker;
  private voice: string;
  sampleRate = 0;
  /** which onnxruntime provider actually took the graph */
  provider = "";

  constructor(config: Config, scriptDir: string) {
    this.voice = config.ttsVoice;
    this.worker = new Worker(config.kokoroPythonBin,
      [join(scriptDir, "kokoro_worker.py"), config.kokoroModel, config.kokoroVoices, config.ttsVoice],
      { LD_LIBRARY_PATH: cudaLibraryPath(config.kokoroPythonBin) });
  }

  async start(): Promise<void> {
    const ready = await this.worker.start();
    this.sampleRate = typeof ready.sample_rate === "number" ? ready.sample_rate : 0;
    this.provider = typeof ready.provider === "string" ? ready.provider : "";
    // The silent failure this engine has: without the CUDA libraries
    // onnxruntime takes the graph on the CPU, nothing errors, and the first
    // sentence goes from a tenth of a second to a whole one.
    if (this.provider !== "CUDAExecutionProvider") {
      console.log(`warning: kokoro is running on ${this.provider || "an unknown provider"}, not the GPU. Expect about a second a sentence.`);
    }
  }

  use(voice: string): void { this.voice = voice; }

  async synthesize(text: string, wavPath: string): Promise<string> {
    const reply = await this.worker.request({ text, wav: wavPath, voice: this.voice });
    return typeof reply.wav === "string" ? reply.wav : wavPath;
  }

  stop(): void { this.worker.stop(); }
}

/**
 * 4.9 a voice that is a recording, not a name on a list. The reference clip
 * decides who speaks, so `voiceChoices` names two files under `chatterboxRefs`
 * and 9.4 switches between them the same way it always did.
 *
 * It is about twenty times slower than kokoro a sentence, which is the reason
 * kokoro remains the default and the reason 11.6 is worth measuring after a
 * switch.
 */
export class LocalChatterbox implements TextToSpeech {
  private worker: Worker;
  private voice: string;
  sampleRate = 0;
  /** cuda or cpu, as the worker found it; the CPU path is minutes, not seconds */
  device = "";

  constructor(config: Config, scriptDir: string) {
    this.voice = config.ttsVoice;
    this.worker = new Worker(config.chatterboxPythonBin,
      [join(scriptDir, "chatterbox_worker.py"), config.chatterboxRefs, config.ttsVoice,
        String(config.chatterboxExaggeration), String(config.chatterboxCfg)],
      {});
  }

  async start(): Promise<void> {
    const ready = await this.worker.start();
    this.sampleRate = typeof ready.sample_rate === "number" ? ready.sample_rate : 0;
    this.device = typeof ready.device === "string" ? ready.device : "";
    if (this.device !== "cuda") {
      console.log(`warning: chatterbox is running on ${this.device || "an unknown device"}. A sentence costs minutes there, not seconds.`);
    }
  }

  use(voice: string): void { this.voice = voice; }

  async synthesize(text: string, wavPath: string): Promise<string> {
    const reply = await this.worker.request({ text, wav: wavPath, voice: this.voice });
    return typeof reply.wav === "string" ? reply.wav : wavPath;
  }

  stop(): void { this.worker.stop(); }
}

/** 4.8 the seam: which engine speaks is a setting, and nothing above here knows. */
export function textToSpeech(config: Config, scriptDir: string): TextToSpeech {
  if (config.ttsEngine === "piper") return new LocalPiper(config, scriptDir);
  if (config.ttsEngine === "chatterbox") return new LocalChatterbox(config, scriptDir);
  return new LocalKokoro(config, scriptDir);
}

/**
 * One sentence of lookahead (5.7, 11.6).
 *
 * The bridge speaks one sentence at a time and waits for each to finish, so
 * before this every gap between sentences was a whole synthesis: about a
 * tenth of a second with kokoro, which nobody hears, and about three seconds
 * with the cloning voice, which everybody does. A sentence takes longer to say
 * than to make, so making the next one while this one plays hides the cost of
 * every sentence after the first.
 *
 * The cache holds exactly one sentence, keyed by its text. A sentence a
 * barge-in cut comes back to the front of the queue, and the queue can be
 * jumped, so what plays next is not always what was made ready: a miss just
 * synthesizes, which is what happened every time before.
 */
export class SpokenAhead {
  private ready: { text: string; wav: Promise<string> } | null = null;
  private counter = 0;

  constructor(private readonly tts: TextToSpeech, private readonly scratch: string) {}

  /** The wav for this sentence, already made if it was the one expected. */
  take(text: string): Promise<string> {
    const ready = this.ready;
    this.ready = null;
    if (ready?.text === text) return ready.wav;
    return this.make(text);
  }

  /**
   * Start the next sentence. Call it once the current sentence is playing:
   * the engine answers one request at a time, so starting earlier would put
   * this sentence behind the next one.
   */
  start(text: string | undefined): void {
    if (!text || this.ready?.text === text) return;
    this.ready = { text, wav: this.make(text) };
  }

  private make(text: string): Promise<string> {
    const wav = join(this.scratch, `say-${++this.counter}.wav`);
    // a rejection here is answered where the wav is awaited, and an unobserved
    // prefetch must not take the process down with it
    const made = this.tts.synthesize(text, wav);
    made.catch(() => {});
    return made;
  }
}
