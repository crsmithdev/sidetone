import { describe, expect, test } from "bun:test";
import type { Utterance } from "../src/audio.ts";
import { Ear, type EarOptions } from "../src/ear.ts";
import { Measures } from "../src/measures.ts";
import type { TurnGuess } from "../src/diagnostics.ts";
import { TurnGuesses, type TurnScore } from "../src/turn.ts";
import { fakeClock, pass } from "./clock.ts";

const OPTIONS: EarOptions = {
  sampleRate: 16_000,
  endOfTurnPauseMs: 900,
  speechOnsetMs: 50,
  speechLevel: 0.02,
  bargeInLevel: 0.05,
  bargeInMs: 400,
  bargeInGapMs: 120,
  minSpeechPeak: 0.15,
  earlyTranscribeMs: 200,
};

function frame(level: number, ms = 20): Int16Array {
  const samples = new Int16Array(Math.round((OPTIONS.sampleRate * ms) / 1000));
  samples.fill(Math.round(level * 32768));
  return samples;
}
const speech = (frames: number) => Array.from({ length: frames }, () => frame(0.4));
const quiet = (frames: number) => Array.from({ length: frames }, () => frame(0.001));
fakeClock();
const settle = (ms = 0) => pass(ms);
/** Frames one after another, a millisecond apart, as the event loop of the real clock gave them. */
async function play(ear: Ear, frames: Int16Array[]): Promise<void> {
  for (const f of frames) { ear.frame(f); await settle(1); }
}

/**
 * The ear with a fake turn detector. `score` is the worker: it is handed the
 * audio the model would get and answers however the test says.
 */
function room(score: ((pcm: Int16Array, rate: number) => Promise<TurnScore>) | null, transcribe: () => Promise<string> = async () => "what is two plus two", waitMs = 50) {
  const told: string[] = [];
  const lines: TurnGuess[] = [];
  const measures = new Measures();
  const guesses = new TurnGuesses(OPTIONS.sampleRate, (line) => lines.push(line), waitMs);
  guesses.score = score;
  const to = {
    isMuted: false,
    cue: (name: string) => told.push(`cue ${name}`),
    stopSpeaking: () => told.push("stop"),
    heard: async (text: string) => { told.push(`heard ${text}`); },
    heardNothing: () => told.push("nothing"),
    retract: () => { told.push("retract"); return true; },
  };
  const ear = new Ear(to, transcribe, { ...OPTIONS }, measures, () => {}, guesses);
  return { told, lines, ear };
}

const sure = (probability: number) => async (): Promise<TurnScore> => ({ probability, inferenceMs: 12 });

describe("the turn detector in shadow (18.16)", () => {
  test("a pause that ends the utterance is one line: the guess, the quiet at it, the words, and ended", async () => {
    const { lines, told, ear } = room(sure(0.91));
    await play(ear, [...speech(20), ...quiet(50)]);
    await settle(10);
    expect(told.at(-1)).toBe("heard what is two plus two");
    expect(lines).toEqual([{
      kind: "turnGuess", at: expect.any(Number), probability: 0.91, inferenceMs: 12, quietMs: 200,
      outcome: "ended", endedBy: "pause", text: "what is two plus two",
    }]);
  });

  test("speech after the guess is resumed, with how long the quiet ran; the next quiet is a guess of its own", async () => {
    const scores = [0.8, 0.2];
    const { lines, ear } = room(async () => ({ probability: scores.shift() ?? 0, inferenceMs: 9 }));
    await play(ear, [...speech(20), ...quiet(15), ...speech(10), ...quiet(50)]);
    await settle(10);
    lines.sort((a, b) => a.at - b.at);
    expect(lines).toMatchObject([
      { probability: 0.8, quietMs: 200, outcome: "resumed", resumedAfterMs: 300 },
      { probability: 0.2, quietMs: 200, outcome: "ended", endedBy: "pause" },
    ]);
    expect(lines[0]).not.toHaveProperty("endedBy");
    expect(lines[1]).not.toHaveProperty("resumedAfterMs");
  });

  test("a release after the guess ended the utterance on a release", async () => {
    const { lines, ear } = room(sure(0.4));
    await play(ear, [...speech(20), ...quiet(12)]);
    ear.reset(true);
    await settle(10);
    expect(lines).toMatchObject([{ outcome: "ended", endedBy: "flush", quietMs: 200 }]);
  });

  test("a cut microphone drops the recording, and the guess says so", async () => {
    const { lines, ear } = room(sure(0.4));
    await play(ear, [...speech(20), ...quiet(12)]);
    ear.reset(false);
    await settle(10);
    expect(lines).toMatchObject([{ outcome: "cut" }]);
  });

  test("the line waits for the outcome, and is written once", async () => {
    const { lines, ear } = room(sure(0.9));
    await play(ear, [...speech(20), ...quiet(20)]);
    await settle(10);
    expect(lines).toEqual([]);
    for (const f of quiet(30)) ear.frame(f);
    await settle(10);
    expect(lines).toHaveLength(1);
  });

  test("the worker gets the last eight seconds, at the room's rate", async () => {
    const got: Array<[number, number]> = [];
    const { ear } = room(async (pcm, rate) => { got.push([pcm.length, rate]); return { probability: 0.5, inferenceMs: 1 }; });
    await play(ear, [...speech(500), ...quiet(12)]);
    await settle(0);
    expect(got).toEqual([[8 * OPTIONS.sampleRate, OPTIONS.sampleRate]]);
  });

  test("off, or a worker that never loaded, writes nothing", async () => {
    const { lines, told, ear } = room(null);
    await play(ear, [...speech(20), ...quiet(50)]);
    await settle(10);
    expect(told.at(-1)).toBe("heard what is two plus two");
    expect(lines).toEqual([]);
  });
});

/**
 * 18.16 nothing Chris hears changes. A worker that hangs, throws or dies
 * leaves the utterance to end, be read and be sent exactly as before.
 */
describe("the detector never holds up the ear (18.16)", () => {
  test("a worker that never answers: the utterance is heard at once, and the line has no probability", async () => {
    const { lines, told, ear } = room(() => new Promise<TurnScore>(() => {}));
    await play(ear, [...speech(20), ...quiet(50)]);
    await settle(0);
    expect(told.at(-1)).toBe("heard what is two plus two");
    expect(lines).toEqual([]);
    await settle(80);
    expect(lines).toMatchObject([{ probability: null, inferenceMs: null, outcome: "ended" }]);
  });

  test("a worker that throws, at once or later, changes nothing", async () => {
    for (const score of [() => { throw new Error("dead"); }, async () => { throw new Error("the worker stopped"); }]) {
      const { lines, told, ear } = room(score);
      await play(ear, [...speech(20), ...quiet(50)]);
      await settle(10);
      expect(told.at(-1)).toBe("heard what is two plus two");
      expect(lines).toMatchObject([{ probability: null, outcome: "ended" }]);
    }
  });

  test("a busy worker is not sent a second request: that guess has no probability", async () => {
    let asked = 0;
    const { lines, ear } = room(() => { asked++; return new Promise<TurnScore>(() => {}); }, undefined, 20);
    await play(ear, [...speech(20), ...quiet(15), ...speech(10), ...quiet(50)]);
    await settle(60);
    expect(asked).toBe(1);
    lines.sort((a, b) => a.at - b.at);
    expect(lines).toMatchObject([{ outcome: "resumed", probability: null }, { outcome: "ended", probability: null }]);
  });

  test("a transcription that never comes back leaves the words out", async () => {
    let calls = 0;
    const { lines, ear } = room(sure(0.7), () => (++calls === 1 ? new Promise<string>(() => {}) : Promise.resolve("later")));
    await play(ear, [...speech(20), ...quiet(15), ...speech(10), ...quiet(50)]);
    await settle(80);
    expect(lines.find((line) => line.outcome === "resumed")).toMatchObject({ text: null });
    expect(lines.find((line) => line.outcome === "ended")).toMatchObject({ text: "later" });
  });
});

/**
 * 18.18 the detector ends the turn at the tentative end. Speech that the
 * bridge hears inside the join window retracts the turn, and the rest joins
 * the first part as one utterance. After the window, or once the turn cannot
 * go, it is a plain barge-in.
 */
describe("ending a turn on the guess (18.18)", () => {
  /**
   * The ear in "end" mode. Each transcription says how much speech it read, so
   * a join shows. 400 ms of speech is a barge-in, so each test starts with a stop.
   */
  function ending(joinMs: number, options: { retract?: () => boolean; probability?: number; transcribe?: (utterance: Utterance) => Promise<string> } = {}) {
    const told: string[] = [];
    const lines: TurnGuess[] = [];
    const guesses = new TurnGuesses(OPTIONS.sampleRate, (line) => lines.push(line), 50);
    guesses.score = sure(options.probability ?? 0.9);
    const to = {
      isMuted: false,
      cue: () => {},
      stopSpeaking: () => told.push("stop"),
      heard: async (text: string) => { told.push(`heard ${text}`); },
      heardNothing: () => told.push("nothing"),
      retract: () => { const gone = options.retract?.() ?? true; told.push(`retract ${gone}`); return gone; },
    };
    const transcribe = options.transcribe ?? (async (utterance: Utterance) => `${utterance.speechMs} ms of speech`);
    const ear = new Ear(to, transcribe, { ...OPTIONS, turnDetector: "end", turnEndProbability: 0.5, turnJoinMs: joinMs }, new Measures(), () => {}, guesses);
    return { told, lines, ear };
  }

  test("the guess ends the utterance at the tentative end, not at the pause", async () => {
    const { told, lines, ear } = ending(600);
    await play(ear, [...speech(20), ...quiet(12)]);
    await settle(10);
    // 240 ms of quiet, where the pause is 900
    expect(told).toEqual(["stop", "heard 400 ms of speech"]);
    expect(lines).toMatchObject([{ probability: 0.9, outcome: "ended", endedBy: "detector" }]);
  });

  test("a guess under the threshold leaves the utterance to the pause", async () => {
    const { told, ear } = ending(600, { probability: 0.3 });
    await play(ear, [...speech(20), ...quiet(20)]);
    await settle(10);
    expect(told).toEqual(["stop"]);
    await play(ear, quiet(30));
    await settle(10);
    expect(told).toEqual(["stop", "heard 400 ms of speech"]);
  });

  test("a resume inside the window retracts the turn and sends one utterance, joined", async () => {
    const { told, ear } = ending(600);
    // the bridge hears him again 360 ms after his last word: 300 of quiet and the onset
    await play(ear, [...speech(20), ...quiet(15), ...speech(10), ...quiet(50)]);
    await settle(10);
    expect(told).toEqual(["stop", "heard 400 ms of speech", "retract true", "heard 600 ms of speech"]);
  });

  test("a resume after the window is a barge-in, and a new utterance", async () => {
    const { told, ear } = ending(250);
    await play(ear, [...speech(20), ...quiet(15), ...speech(25), ...quiet(50)]);
    await settle(10);
    expect(told).toEqual(["stop", "heard 400 ms of speech", "stop", "heard 500 ms of speech"]);
  });

  test("a turn that has spoken is not retracted: the resume is a barge-in", async () => {
    const { told, ear } = ending(600, { retract: () => false });
    await play(ear, [...speech(20), ...quiet(15), ...speech(25), ...quiet(50)]);
    await settle(10);
    expect(told).toEqual(["stop", "heard 400 ms of speech", "retract false", "stop", "heard 500 ms of speech"]);
  });

  test("words still being read when he goes on reach nobody: the joined utterance carries them", async () => {
    let release = () => {};
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const { told, ear } = ending(600, { transcribe: async (utterance) => { if (utterance.speechMs === 400) await gate; return `${utterance.speechMs} ms of speech`; } });
    await play(ear, [...speech(20), ...quiet(15), ...speech(10)]);
    release();
    await play(ear, quiet(50));
    await settle(10);
    expect(told).toEqual(["stop", "heard 600 ms of speech"]);
  });
});
