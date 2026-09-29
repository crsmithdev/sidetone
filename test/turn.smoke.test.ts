import { afterAll, beforeAll, describe, expect, jest, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeWav, level } from "../src/audio.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import type { TurnGuess } from "../src/diagnostics.ts";
import { SmartTurn, type TurnDetector } from "../src/speech.ts";
import { fakeClock, settle } from "./clock.ts";
import { bridge, RATE, type Script } from "./harness.ts";

/**
 * 18.18 the retract and join window, on Chris's own voice.
 *
 * The saved utterances in ~/.sidetone/heard go through the real ear and the
 * real Smart Turn worker on the CPU, in "end" mode, to a stand-in agent. The
 * record says which of them Chris split with a pause: a `resumed` guess inside
 * the utterance. Each clip plays at the rate it was spoken, and the clock waits
 * for the model, so a guess lands as late as it lands in the car.
 *
 * It wants the model, the Python environment and the saved clips, and it takes
 * about ten seconds. Ask for it by name:
 *
 *   SIDETONE_TURN=1 bun test turn.smoke
 *
 * The transcriber is a stand-in too: it writes how long the audio is, so a
 * joined utterance shows, and the clips that are commands reach the agent like
 * the rest. What whisper makes of a joined utterance is not in this check.
 */
const HOME = join(process.env.HOME ?? "", ".sidetone");
const speechDir = new URL("../speech", import.meta.url).pathname;
/** a worktree has no environment of its own: the main checkout's is the one */
const python = [DEFAULTS.pythonBin, DEFAULTS.pythonBin.replace(/\/\.worktrees\/[^/]+\//, "/")].find((path) => existsSync(path)) ?? DEFAULTS.pythonBin;
const asked = process.env.SIDETONE_TURN === "1";
const present = existsSync(DEFAULTS.turnModel) && existsSync(python) && existsSync(join(HOME, "heard")) && existsSync(join(HOME, "record.jsonl"));
const run = asked && present;
if (asked && !present) console.log(`turn smoke: the model, ${python}, or the saved clips in ${HOME} are absent`);

fakeClock();

/**
 * 10 ms, the frame the car's ear gets: transport.ts sets no frame size, and
 * LiveKit's own is 10 ms. The ear takes the level of a frame, and one loud
 * frame is a resume, so a longer frame hides a short sound the car heard.
 */
const FRAME = RATE / 100;
const PROBABILITY = DEFAULTS.turnEndProbability;
const JOIN_MS = DEFAULTS.turnJoinMs;
/**
 * How long the process takes to end a turn after the interrupt. Not measured:
 * a guess, so that a joined turn waits for the one it replaces, as it does in
 * the car.
 */
const INTERRUPT_MS = 500;

interface Clip {
  name: string;
  /** mono at the test's rate */
  samples: Int16Array;
  /** the guesses the car made in this utterance */
  guesses: TurnGuess[];
  split: boolean;
}

/**
 * The saved clips the record can place. The bridge keeps the audio of each
 * transcription, and it transcribes at every tentative end (18.4), so a clip
 * belongs to the guess made just before it with the same words. A clip made at
 * a guess Chris then talked past holds only the part before the pause, and is
 * left out. A clip made at the guess that ended the utterance holds all of it:
 * split when the utterance had a guess he talked past.
 */
function clips(): Clip[] {
  const guesses = readFileSync(join(HOME, "record.jsonl"), "utf8").split("\n")
    .filter((line) => line.includes('"turnGuess"')).map((line) => JSON.parse(line) as TurnGuess)
    .sort((a, b) => a.at - b.at);
  const utterances: TurnGuess[][] = [];
  let open: TurnGuess[] = [];
  for (const guess of guesses) {
    open.push(guess);
    if (guess.outcome !== "resumed") { utterances.push(open); open = []; }
  }
  const same = (a: string | null | undefined, b: string) => (a ?? "").trim().toLowerCase() === b.trim().toLowerCase();
  const dir = join(HOME, "heard");
  const found: Clip[] = [];
  const placed = new Set<TurnGuess>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
    const { text } = JSON.parse(readFileSync(join(dir, file), "utf8")) as { text: string };
    const at = Number(file.split("-")[0]);
    const guess = guesses.filter((g) => g.at <= at && at - g.at < 3_000 && same(g.text, text)).at(-1);
    if (!guess || guess.outcome !== "ended" || placed.has(guess)) continue;
    placed.add(guess);
    const utterance = utterances.find((u) => u.includes(guess))!;
    const wav = decodeWav(readFileSync(join(dir, file.replace(/\.json$/, ".wav"))));
    found.push({ name: file.replace(/\.json$/, ""), samples: resample(wav.samples, wav.sampleRate), guesses: utterance, split: utterance.some((g) => g.outcome === "resumed") });
  }
  return found;
}

/**
 * The room's rate from a saved clip's, one sample in each run. A mean would
 * lower the peak, and the invention guard reads the peak: one clip fell under
 * it that way.
 */
function resample(samples: Int16Array, rate: number): Int16Array {
  const step = rate / RATE;
  const out = new Int16Array(Math.floor(samples.length / step));
  for (let i = 0; i < out.length; i++) out[i] = samples[Math.floor(i * step)]!;
  return out;
}

/** A clip up to its last loud frame: a saved clip keeps the quiet that ended it. */
function toLastWord(samples: Int16Array): Int16Array {
  let end = 0;
  for (let at = 0; at + FRAME <= samples.length; at += FRAME) if (level(samples.subarray(at, at + FRAME)) >= DEFAULTS.speechLevel) end = at + FRAME;
  return samples.subarray(0, end);
}

const silence = (ms: number) => new Int16Array((RATE * ms) / 1000).fill(Math.round(0.001 * 32768));

function concat(...parts: Int16Array[]): Int16Array {
  const out = new Int16Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

let worker: SmartTurn;
/** a request the worker has not answered, which the clock waits for */
let inflight: Promise<unknown> | null = null;

/**
 * The real worker, on the fake clock: the answer comes `inferenceMs` after the
 * ask, as it does in the car, however long the test machine took.
 */
const detector: TurnDetector = {
  start: async () => {},
  loadSeconds: 0,
  async score(pcm, rate) {
    const askedAt = Date.now();
    const asking = worker.score(pcm, rate);
    inflight = asking;
    const score = await asking;
    inflight = null;
    const wait = askedAt + score.inferenceMs - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return score;
  },
  stop: () => {},
};

interface Played {
  /** each utterance the agent was asked, as the seconds of audio in it */
  asks: number[];
  interrupts: number;
  /** the fake time of each ask */
  askedAt: number[];
  lines: TurnGuess[];
  journal: string[];
  /** when the pause would have ended the last utterance */
  pauseEndAt: number;
  /** 4.6 the invention guard dropped an utterance */
  tooQuiet: boolean;
}

/**
 * Plays `samples` into a bridge in "end" mode, 10 ms at a time on a clock that
 * moves 10 ms, with a second of quiet before and at least three after.
 *
 * The stand-in agent holds each turn until it is interrupted or the audio
 * ends, as a real turn runs for seconds; `answerAtOnce` answers at once.
 * An interrupted turn ends `INTERRUPT_MS` later.
 */
async function play(samples: Int16Array, overrides: Partial<Config> = {}, answerAtOnce = false): Promise<Played> {
  const holds: Array<() => void> = [];
  const script: Script = {};
  const hold = () => { script.hold = new Promise<void>((resolve) => holds.push(resolve)); };
  if (!answerAtOnce) {
    hold();
    script.onInterrupt = () => {
      const end = holds.shift();
      hold();
      setTimeout(() => end?.(), INTERRUPT_MS);
    };
  }
  const r = bridge({ turn: detector, overrides: { turnDetector: "end", turnEndProbability: PROBABILITY, turnJoinMs: JOIN_MS, ...overrides }, script });
  await settle();
  r.stt.transcribe = async (wav) => (decodeWav(await Bun.file(wav).bytes()).samples.length / RATE).toFixed(2);
  const audio = concat(silence(1_000), samples);
  const frames: Int16Array[] = [];
  for (let at = 0; at + FRAME <= audio.length; at += FRAME) frames.push(audio.subarray(at, at + FRAME));
  let lastLoud = 0;
  frames.forEach((frame, i) => { if (level(frame) >= DEFAULTS.speechLevel) lastLoud = i; });
  let lastWordAt = 0;
  const askedAt: number[] = [];
  const asks = () => r.agent.calls.filter((call) => call.startsWith("ask ") || call.startsWith("inject "));
  const quiet = silence(10);
  // after the clip the room is quiet: for three seconds, and on while the ear
  // still reads or an ask came in the last second, up to twenty
  const more = (i: number) => i < frames.length + 300 || (i < frames.length + 2_000 && (r.ear.hearing || Date.now() - (askedAt.at(-1) ?? 0) < 1_000));
  for (let i = 0; more(i); i++) {
    r.ear.frame(frames[i] ?? quiet);
    if (i === lastLoud) lastWordAt = Date.now();
    for (let step = 0; step < 5; step++) {
      jest.advanceTimersByTime(2);
      await settle();
      while (inflight) { await inflight; await settle(); }
      while (askedAt.length < asks().length) askedAt.push(Date.now());
    }
  }
  for (const release of holds) release();
  await settle();
  return {
    asks: asks().map((call) => Number(call.split("\n\n").at(-1))),
    interrupts: r.agent.calls.filter((call) => call === "interrupt").length,
    askedAt,
    lines: r.measures.recent().filter((event): event is TurnGuess => event.kind === "turnGuess"),
    journal: r.journal,
    pauseEndAt: lastWordAt + r.config.endOfTurnPauseMs,
    tooQuiet: r.journal.some((line) => line.includes("(too quiet")),
  };
}

const median = (values: number[]) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

describe.skipIf(!run)("the retract and join window, on saved audio (18.18)", () => {
  let all: Clip[] = [];
  const results = new Map<string, Played>();

  beforeAll(async () => {
    worker = new SmartTurn({ ...DEFAULTS, pythonBin: python }, speechDir);
    await worker.start();
    all = clips();
  }, 60_000);

  afterAll(() => {
    worker?.stop();
    const heard = all.filter((clip) => results.has(clip.name) && !(results.get(clip.name)!.tooQuiet && results.get(clip.name)!.asks.length === 0));
    const quiet = all.filter((clip) => results.has(clip.name)).length - heard.length;
    const whole = heard.filter((clip) => !clip.split);
    const split = heard.filter((clip) => clip.split);
    const played = (clip: Clip) => results.get(clip.name)!;
    const early = whole.filter((clip) => played(clip).lines.some((line) => line.endedBy === "detector"));
    const saved = early.map((clip) => played(clip).pauseEndAt - played(clip).askedAt[0]!);
    const joined = split.filter((clip) => played(clip).interrupts > 0);
    const cut = split.filter((clip) => played(clip).asks.length - played(clip).interrupts > 1);
    // speech came back before the guess did, or the guess was under the threshold
    const paused = split.filter((clip) => !joined.includes(clip) && !cut.includes(clip) && played(clip).lines.some((line) => line.outcome === "resumed"));
    // the detector ended it, and what the car took for a resume was too short to start an utterance
    const noise = split.filter((clip) => !joined.includes(clip) && !cut.includes(clip) && !paused.includes(clip));
    const carEnds = whole.filter((clip) => (clip.guesses.at(-1)!.probability ?? 0) >= PROBABILITY).length;
    console.log([
      "",
      `turn smoke, threshold ${PROBABILITY}, window ${JOIN_MS} ms: ${all.length} saved clips placed in the record, ${quiet} too quiet to reach the agent`,
      `  whole: ${whole.length}, ended early ${early.length} (the car's own guess was at the threshold for ${carEnds}), median pause saved ${median(saved)} ms`,
      `  split: ${split.length}, retracted and joined ${joined.length}, joined by the pause ${paused.length}, ended early with a resume too short to be speech ${noise.length}, cut off ${cut.length}`,
    ].join("\n"));
  });

  test("a whole utterance is one turn, never retracted; the ones the detector ends save pause", async () => {
    const whole = all.filter((clip) => !clip.split);
    expect(whole.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const clip of whole) {
      const played = await play(clip.samples);
      results.set(clip.name, played);
      if (played.tooQuiet && played.asks.length === 0) continue;
      if (played.asks.length !== 1 || played.interrupts > 0) wrong.push(`${clip.name}: asked ${played.asks.join(", ")} s, ${played.interrupts} interrupts`);
      else if (played.lines.some((line) => line.endedBy === "detector") && !(played.askedAt[0]! < played.pauseEndAt)) wrong.push(`${clip.name}: a detector end saved nothing`);
    }
    expect(wrong).toEqual([]);
  }, 600_000);

  test("an utterance Chris split with a pause is one turn: retracted and joined, or joined by the pause", async () => {
    const split = all.filter((clip) => clip.split);
    expect(split.length).toBeGreaterThan(0);
    const wrong: string[] = [];
    for (const clip of split) {
      const played = await play(clip.samples);
      results.set(clip.name, played);
      // near the invention guard the replay can fall under it where the car did not
      if (played.tooQuiet && played.asks.length === 0) continue;
      // every turn but the last was retracted, and the last carries the audio of each
      const last = played.asks.at(-1) ?? 0;
      if (played.asks.length - played.interrupts !== 1 || played.asks.some((seconds) => seconds > last)) wrong.push(`${clip.name}: asked ${played.asks.join(", ")} s, ${played.interrupts} interrupts`);
      if (played.journal.some((line) => line.includes("could not be retracted"))) wrong.push(`${clip.name}: a turn could not be retracted`);
    }
    expect(wrong).toEqual([]);
  }, 600_000);

  test("two utterances with a gap the window does not cover are two turns: the second is a barge-in", async () => {
    // two whole clips the detector ends, 1.2 s apart: inside the pause, so
    // today it is one utterance; with a window of 800 ms it is a cut-off
    const ending = all.filter((clip) => !clip.split && results.get(clip.name)?.lines.some((line) => line.endedBy === "detector"));
    expect(ending.length).toBeGreaterThanOrEqual(2);
    const [a, b] = ending as [Clip, Clip];
    const gapped = concat(toLastWord(a.samples), silence(1_200), b.samples);
    const after = await play(gapped, { turnJoinMs: 800 }, true);
    expect(after.interrupts).toBe(0);
    expect(after.asks).toHaveLength(2);
    expect(after.journal.filter((line) => line.startsWith("  [barge-in"))).toHaveLength(2);
    // the same audio with the window at the pause is one turn, the two joined
    const inside = await play(gapped);
    expect(inside.asks.length - inside.interrupts).toBe(1);
    expect(inside.asks.at(-1)!).toBeGreaterThan((a.samples.length + b.samples.length) / RATE);
  }, 120_000);
});
