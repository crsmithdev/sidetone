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
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Subprocess } from "bun";
import type { Config } from "./config.ts";
import { linesOf } from "./protocol.ts";
import type { SentClips, Source } from "./sent.ts";

/** 4.8 the seam. A local engine only: there is no cloud engine to put here. */
export interface SpeechToText {
  start(): Promise<void>;
  /** Non-zero once the engine has warmed, which is how the health check knows. */
  readonly warmupSeconds: number;
  transcribe(wavPath: string): Promise<string>;
  stop(): void;
}

export interface TextToSpeech {
  start(): Promise<void>;
  /** Non-zero once the engine has answered, which is how the health check knows. */
  readonly sampleRate: number;
  /** Writes the speech to wavPath and returns it. */
  synthesize(text: string, wavPath: string): Promise<string>;
  /** 9.4 whether the voice is a name taken per request. A fact, so no caller has to ask twice. */
  readonly switchable: boolean;
  /** 9.4 change voice without a restart. An engine of one voice keeps the one it has. */
  use(voice: string): void;
  /**
   * Which voice is speaking now. A kept sentence belongs to the voice that
   * said it, so this is part of the key it is kept under.
   */
  readonly voice: string;
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

  constructor(private readonly bin: string, private readonly args: string[]) {}

  async start(): Promise<Record<string, unknown>> {
    const ready = this.next();
    // the CUDA wheels of this interpreter's own environment, when it has any
    const libraries = cudaLibraryPath(this.bin);
    this.child = Bun.spawn([this.bin, ...this.args], {
      stdin: "pipe", stdout: "pipe", stderr: "inherit",
      env: libraries ? { ...process.env, LD_LIBRARY_PATH: libraries } : process.env,
    }) as Subprocess<"pipe", "pipe", "inherit">;
    void this.pump();
    const first = await ready;
    if (first.ready !== true) throw new Error(`${this.args[0]} did not start: ${JSON.stringify(first)}`);
    return first;
  }

  private async pump(): Promise<void> {
    const child = this.child;
    if (!child) return;
    for await (const line of linesOf(child.stdout as ReadableStream<Uint8Array>)) {
      const resolve = this.waiting.shift();
      if (!resolve) continue;
      try { resolve(JSON.parse(line) as Record<string, unknown>); }
      catch { resolve({ error: `the worker said something that is not JSON: ${line.slice(0, 120)}` }); }
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
    this.worker = new Worker(config.pythonBin, [join(scriptDir, "stt_worker.py"), config.sttModel, config.modelsDir]);
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

/**
 * 4.8 what differs between the voices, in one place: the worker to start,
 * whether a voice is a name the worker takes per request, what its ready line
 * has to warn about, and which settings shape the voice. Nothing else in this
 * file, and nothing above it, tells one engine from another.
 */
interface Engine {
  worker(config: Config, scriptDir: string): { bin: string; args: string[] };
  /** 9.4 whether a switch is a different name on the next request */
  switchable: boolean;
  /** 4.9 the engine names its own voices, so a voice is only a default beside its engine */
  voices: Pick<Config, "ttsVoice" | "voiceChoices">;
  /** the silent failure this engine has, read off its ready line */
  warn?(ready: Record<string, unknown>): string | null;
  /** the settings that shape the voice, so a sentence kept at one is never played back at another */
  signature?(config: Config): string;
}

export const ENGINES: Record<Config["ttsEngine"], Engine> = {
  /** 4.9 the first working local voice, on the CPU. One voice per model file. */
  piper: {
    worker: (config, dir) => ({ bin: config.pythonBin, args: [join(dir, "tts_worker.py"), join(config.modelsDir, `${config.ttsVoice}.onnx`)] }),
    switchable: false,
    // one voice, and the switch command says so
    voices: { ttsVoice: "en_US-lessac-medium", voiceChoices: { female: "en_US-lessac-medium", male: "en_US-lessac-medium" } },
  },
  /**
   * 4.9 the same job on the GPU, which was idle. All 54 voices share one
   * model, so a switch costs nothing and can happen between two sentences.
   */
  kokoro: {
    worker: (config, dir) => ({ bin: config.kokoroPythonBin, args: [join(dir, "kokoro_worker.py"), config.kokoroModel, config.kokoroVoices, config.ttsVoice] }),
    switchable: true,
    voices: { ttsVoice: "bf_emma", voiceChoices: { female: "bf_emma", male: "bm_george" } },
    // Without the CUDA libraries onnxruntime takes the graph on the CPU,
    // nothing errors, and the first sentence goes from a tenth of a second to
    // a whole one.
    warn: (ready) => ready.provider === "CUDAExecutionProvider"
      ? null
      : `kokoro is running on ${String(ready.provider || "an unknown provider")}, not the GPU. Expect about a second a sentence.`,
  },
  /**
   * 4.9 a voice that is a recording, not a name on a list. The reference clip
   * decides who speaks, so `voiceChoices` names two files under
   * `chatterboxRefs`. It is about twenty times slower than kokoro a sentence,
   * which is the reason 11.6 is worth measuring after a switch.
   */
  chatterbox: {
    worker: (config, dir) => ({
      bin: config.chatterboxPythonBin,
      args: [join(dir, "chatterbox_worker.py"), config.chatterboxRefs, config.ttsVoice, String(config.chatterboxExaggeration), String(config.chatterboxCfg)],
    }),
    switchable: true,
    voices: { ttsVoice: "som_00295", voiceChoices: { female: "sof_01208", male: "som_00295" } },
    // the CPU path is minutes a sentence, not seconds, and the model still loads
    warn: (ready) => ready.device === "cuda"
      ? null
      : `chatterbox is running on ${String(ready.device || "an unknown device")}. A sentence costs minutes there, not seconds.`,
    signature: (config) => `${config.chatterboxExaggeration}-${config.chatterboxCfg}`,
  },
};

/** 4.9 the local voice in force. One class; the table says which worker it drives. */
export class LocalVoice implements TextToSpeech {
  private readonly worker: Worker;
  private spoken: string;
  sampleRate = 0;
  /** what the worker said when it was ready: the provider, the device, the warmup */
  ready: Record<string, unknown> = {};

  constructor(private readonly engine: Engine, config: Config, scriptDir: string) {
    const { bin, args } = engine.worker(config, scriptDir);
    this.worker = new Worker(bin, args);
    this.spoken = config.ttsVoice;
  }

  get switchable(): boolean { return this.engine.switchable; }

  /** 9.4 the next request speaks in this voice; an engine of one voice keeps its own. */
  use(voice: string): void {
    if (this.engine.switchable) this.spoken = voice;
  }

  async start(): Promise<void> {
    this.ready = await this.worker.start();
    this.sampleRate = typeof this.ready.sample_rate === "number" ? this.ready.sample_rate : 0;
    const warning = this.engine.warn?.(this.ready);
    if (warning) console.log(`warning: ${warning}`);
  }

  /** Which voice is speaking now. */
  get voice(): string { return this.spoken; }

  async synthesize(text: string, wavPath: string): Promise<string> {
    const reply = await this.worker.request({ text, wav: wavPath, voice: this.spoken });
    return typeof reply.wav === "string" ? reply.wav : wavPath;
  }

  stop(): void { this.worker.stop(); }
}

/** 4.8 the seam: which engine speaks is a setting, and nothing above here knows. */
export function textToSpeech(config: Config, scriptDir: string): TextToSpeech {
  return new LocalVoice(ENGINES[config.ttsEngine], config, scriptDir);
}

/** The key a kept sentence is made under: the engine, and whichever of its settings shape the voice. */
export function voiceSignature(config: Config): string {
  const own = ENGINES[config.ttsEngine].signature?.(config);
  return own ? `${config.ttsEngine}-${own}` : config.ttsEngine;
}

/**
 * 11.6.1 how many takes `warm` makes of a kept line before it gives up. The
 * cloning voice garbles a line of one word most of the time: on 23 September
 * "Muted." came out clean in 2 takes of 12, and "Stopped." in none of 3.
 */
export const WARM_TRIES = 20;

/**
 * The sentences worth keeping between runs, and where to keep them.
 * `check` says whether a wav says its text (11.6.1). Without it every take
 * is kept.
 */
export interface Kept {
  dir: string;
  signature: string;
  lines: readonly string[];
  check?: (wav: string, text: string) => Promise<boolean>;
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
  /**
   * The scratch wav handed out last, removed on the next take: sentences play
   * one at a time, so by then it has played. Without this a session left a wav
   * per sentence under /tmp for as long as the process lived.
   */
  private handed: string | null = null;

  /**
   * `kept` names the sentences worth keeping between runs and where to keep
   * them. Leave it out and nothing is kept, which is what the text loop and
   * every test want.
   *
   * `sent` keeps a copy of each wav as it is taken (18.14). Leave it out and
   * no copy is kept.
   */
  constructor(
    private readonly tts: TextToSpeech,
    private readonly scratch: string,
    private readonly kept?: Kept,
    private readonly sent?: Pick<SentClips, "keep">,
  ) {}

  /** The wav for this sentence, already made if it was the one expected. */
  take(text: string): Promise<string> {
    if (this.handed) { void unlink(this.handed).catch(() => {}); this.handed = null; }
    const ready = this.ready;
    this.ready = null;
    const keeping = this.keptPath(text);
    let wav: Promise<string>;
    let source: Source = "made";
    if (ready?.text === text) wav = ready.wav;
    else {
      this.drop(ready);
      if (keeping && existsSync(keeping)) { wav = Promise.resolve(keeping); source = "kept"; }
      else wav = this.make(text);
    }
    // 18.14 a copy that fails costs the check one clip, never the sentence
    if (this.sent) wav.then((path) => this.sent?.keep(path, text, source)).catch(() => {});
    // a kept line is on disk for good; anything else goes once it has played,
    // and so does a take of a kept line that the check refused (11.6.1)
    wav.then((path) => { if (path !== keeping) this.handed = path; }, () => {});
    return wav;
  }

  /**
   * 9.4 the next sentence is in this voice. False when the engine has one
   * voice. The sentence made ahead was made in the old voice, so it goes.
   */
  use(voice: string): boolean {
    if (!this.tts.switchable) return false;
    this.tts.use(voice);
    this.drop(this.ready);
    this.ready = null;
    return true;
  }

  /** A sentence made ahead that will not play. A kept line stays; it was made for good. */
  private drop(ready: { text: string; wav: Promise<string> } | null): void {
    if (!ready || this.keptPath(ready.text)) return;
    ready.wav.then((path) => unlink(path), () => {}).catch(() => {});
  }

  /**
   * Make every kept line that is missing, and say how many. This is what the
   * warm command runs: the alternative is paying for each one the first time
   * it is needed, which is the moment it is least welcome.
   *
   * 11.6.1 with a check, a line already kept is checked too, and one the check
   * refuses is made again, up to `WARM_TRIES` times. `onEach` says what became
   * of each line: kept from before, made now, or garbled on every try.
   */
  async warm(onEach?: (text: string, outcome: "kept" | "made" | "garbled") => void): Promise<number> {
    let made = 0;
    for (const text of this.kept?.lines ?? []) {
      const path = this.keptPath(text);
      if (!path) continue;
      if (existsSync(path) && (await this.kept?.check?.(path, text) ?? true)) { onEach?.(text, "kept"); continue; }
      await unlink(path).catch(() => {});
      for (let tries = 0; tries < WARM_TRIES && !existsSync(path); tries++) {
        const wav = await this.make(text);
        if (wav !== path) await unlink(wav).catch(() => {});
      }
      const kept = existsSync(path);
      if (kept) made += 1;
      onEach?.(text, kept ? "made" : "garbled");
    }
    return made;
  }

  /**
   * Where this sentence lives when it is kept, or null when it is not one of
   * the kept lines. The voice is in the path because a sentence belongs to the
   * voice that said it, and the signature is there because the settings that
   * shape a voice change it as surely as the voice does.
   */
  private keptPath(text: string): string | null {
    if (!this.kept || !this.kept.lines.includes(text)) return null;
    const voice = this.tts.voice;
    const slug = text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
    return join(this.kept.dir, `${this.kept.signature}-${voice}`, `${slug}.wav`);
  }

  /**
   * Start the next sentence. Call it once the current sentence is playing:
   * the engine answers one request at a time, so starting earlier would put
   * this sentence behind the next one.
   */
  start(text: string | undefined): void {
    if (!text || this.ready?.text === text) return;
    this.drop(this.ready);
    this.ready = { text, wav: this.make(text) };
  }

  private make(text: string): Promise<string> {
    const keeping = this.keptPath(text);
    // A kept line is written under a scratch name and moved into place, so a
    // process that dies mid-sentence leaves no half a wav to be played forever.
    const wav = join(this.scratch, `say-${++this.counter}.wav`);
    const made = keeping
      ? this.tts.synthesize(text, wav).then(async (path) => {
        // 11.6.1 a garbled take plays this once, and is never kept to play again
        if (this.kept?.check && !(await this.kept.check(path, text))) return path;
        await mkdir(dirname(keeping), { recursive: true });
        await rename(path, keeping);
        return keeping;
      })
      : this.tts.synthesize(text, wav);
    // a rejection here is answered where the wav is awaited, and an unobserved
    // prefetch must not take the process down with it
    made.catch(() => {});
    return made;
  }
}
