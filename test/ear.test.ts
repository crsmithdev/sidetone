import { describe, expect, test } from "bun:test";
import type { Utterance } from "../src/audio.ts";
import { Ear, SILENCE_MS, type EarOptions } from "../src/ear.ts";
import { Measures } from "../src/measures.ts";

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

/** The ear, its listener and its bookkeeper, ready to be driven. */
function room(transcribe: () => Promise<string>, muted = false) {
  const to = listener(muted);
  const measures = new Measures();
  // item 44 a threshold can be set on a running ear, so each gets its own copy
  return { to, measures, ear: new Ear(to, transcribe, { ...OPTIONS }, measures, () => {}) };
}

const kinds = (measures: Measures) => measures.recent().map((event) => event.kind);

/** What the ear tells, written down instead of acted on. */
function listener(muted = false) {
  const told: string[] = [];
  return {
    told,
    isMuted: muted,
    cue: (name: string) => told.push(`cue ${name}`),
    stopSpeaking: () => told.push("stop"),
    heard: async (text: string) => { told.push(`heard ${text}`); },
    heardNothing: () => told.push("nothing"),
  };
}

function utterance(peak: number): Utterance {
  return { samples: new Int16Array(160), ms: 1000, speechMs: 700, peak, gapMs: 1200, endedBy: "pause", falseEnds: 0 };
}

/** A frame at a level, as the phone would send it. */
function frame(level: number, ms = 20): Int16Array {
  const samples = new Int16Array(Math.round((OPTIONS.sampleRate * ms) / 1000));
  samples.fill(Math.round(level * 32768));
  return samples;
}

/**
 * 18.4 the transcription starts at the tentative end and is used when the
 * guess was right, so the round trip no longer pays for it after the pause.
 */
describe("transcribing during the pause (18.4)", () => {
  const speech = (frames: number) => Array.from({ length: frames }, () => frame(0.4));
  const quiet = (frames: number) => Array.from({ length: frames }, () => frame(0.001));

  test("the guess was right: one transcription, begun before the pause ran out", async () => {
    const askedAt: number[] = [];
    let pushed = 0;
    const { to, ear } = room(async () => { askedAt.push(pushed); return "what is two plus two"; });
    for (const f of [...speech(20), ...quiet(50)]) { ear.frame(f); pushed++; }
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(askedAt).toHaveLength(1);
    // asked after 200 ms of quiet, not after the 900 ms pause
    expect(askedAt[0]).toBeLessThan(20 + 45);
    expect(to.told.at(-1)).toBe("heard what is two plus two");
  });

  test("the guess was wrong: what was said after it is transcribed, and the early result is dropped", async () => {
    const seen: number[] = [];
    const { to, ear } = room(async () => { seen.push(seen.length); return `reading ${seen.length}`; });
    for (const f of [...speech(20), ...quiet(12), ...speech(10), ...quiet(50)]) ear.frame(f);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // one for the wrong guess, one for the right guess after the second quiet; the utterance uses the second
    expect(seen).toHaveLength(2);
    expect(to.told.at(-1)).toBe("heard reading 2");
  });

  test("a microphone cut throws the guess away with the recording", async () => {
    let asked = 0;
    const { ear } = room(async () => { asked++; return "half a sentence"; });
    for (const f of [...speech(20), ...quiet(12)]) ear.frame(f);
    ear.reset();
    for (const f of [...speech(20), ...quiet(50)]) ear.frame(f);
    await new Promise((resolve) => setTimeout(resolve, 0));
    // the early one before the cut, and the early one after it: neither is reused across the cut
    expect(asked).toBe(2);
  });
});

describe("a hold to talk button let go (9.5.2)", () => {
  const speech = (frames: number) => Array.from({ length: frames }, () => frame(0.4));

  test("the recording ends at once and is read, with no pause to wait out", async () => {
    let asked = 0;
    const { to, ear } = room(async () => { asked++; return "what is two plus two"; });
    // 400 ms of speech and no quiet at all: the end-of-turn pause has not begun
    for (const f of speech(20)) ear.frame(f);
    ear.reset(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toBe(1);
    expect(to.told.at(-1)).toBe("heard what is two plus two");
  });

  test("a plain cut still drops the recording", async () => {
    let asked = 0;
    const { to, ear } = room(async () => { asked++; return "half a sentence"; });
    for (const f of speech(20)) ear.frame(f);
    ear.reset(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toBe(0);
    expect(to.told.filter((line) => line.startsWith("heard"))).toEqual([]);
  });

  test("a release with nothing recorded is a plain cut, and the hold is given back", async () => {
    let asked = 0;
    const { to, ear } = room(async () => { asked++; return ""; });
    ear.reset(true);
    expect(asked).toBe(0);
    expect(to.told).toEqual(["nothing"]);
  });

  test("a release in the middle of a barge-in stops the speech, then reads the words", async () => {
    const { to, ear } = room(async () => "wait");
    for (let i = 0; i < 60; i++) ear.frame(frame(0.30));
    expect(to.told).toContain("stop");
    ear.reset(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(to.told.at(-1)).toBe("heard wait");
    // the barge-in is over: the next one is heard again
    for (let i = 0; i < 60; i++) ear.frame(frame(0.30));
    expect(to.told.filter((line) => line === "stop")).toHaveLength(2);
  });

  test("the guess made during a quiet is used when the release comes after it", async () => {
    let asked = 0;
    const { to, ear } = room(async () => { asked++; return "what is two plus two"; });
    for (const f of [...speech(20), ...Array.from({ length: 12 }, () => frame(0.001))]) ear.frame(f);
    ear.reset(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(asked).toBe(1);
    expect(to.told.at(-1)).toBe("heard what is two plus two");
  });
});

describe("what is too quiet to have been a person (4.6)", () => {
  test("it costs no turn, and the passage comes back", async () => {
    let asked = 0;
    const { to, measures, ear } = room(async () => { asked++; return "Thank you."; });
    await ear.said(utterance(0.12));
    expect(asked).toBe(0);
    expect(to.told).toEqual(["nothing"]);
    // it is still written down: a drive has to show what was thrown away
    expect(measures.recent()).toMatchObject([{ kind: "heard", text: "", transcribeMs: 0 }]);
  });

  test("a real utterance is read, and the clock is told in order", async () => {
    const { to, measures, ear } = room(async () => "what is two plus two");
    await ear.said(utterance(0.43));
    expect(to.told).toEqual(["cue heard", "heard what is two plus two"]);
    expect(kinds(measures)).toEqual(["heard"]);
  });

  test("road noise that carried no words gives the passage back", async () => {
    const { to, ear } = room(async () => "");
    await ear.said(utterance(0.43));
    expect(to.told).toEqual(["cue heard", "nothing"]);
  });

  test("an engine that throws is not a lost passage either", async () => {
    const { to, measures, ear } = room(async () => { throw new Error("worker died"); });
    await ear.said(utterance(0.43));
    expect(to.told).toEqual(["cue heard", "nothing"]);
    expect(measures.recent()).toMatchObject([{ kind: "note", text: expect.stringContaining("worker died") }]);
  });
});

describe("the barge-in edge (11.3)", () => {
  const loud = () => frame(0.30);

  test("one crossing stops the speech once, not once per frame", async () => {
    const { to, measures, ear } = room(async () => "");
    for (let i = 0; i < 60; i++) ear.frame(loud());
    expect(to.told.filter((line) => line === "stop")).toHaveLength(1);
    expect(kinds(measures)).toEqual(["barged"]);
  });

  test("a muted bridge keeps listening and stops shutting up (9.5)", async () => {
    const { to, ear } = room(async () => "", true);
    for (let i = 0; i < 60; i++) ear.frame(loud());
    expect(to.told).not.toContain("stop");
    expect(ear.bargingIn).toBe(false);
  });

  test("quiet frames are not a barge-in", async () => {
    const { to, ear } = room(async () => "");
    for (let i = 0; i < 60; i++) ear.frame(frame(0.005));
    expect(to.told).toEqual([]);
  });
});

describe("the phone cuts its microphone", () => {
  test("the hold goes with the half recording", async () => {
    const { to, ear } = room(async () => "");
    for (let i = 0; i < 60; i++) ear.frame(frame(0.30));
    expect(to.told).toContain("stop");
    // before this, nothing resolved the hold: no utterance could ever arrive,
    // and the rest of the answer waited for the ten-second backstop
    ear.reset();
    expect(to.told.at(-1)).toBe("nothing");
  });

  test("a cut clears the barge-in, so the next one is heard again", async () => {
    const { to, ear } = room(async () => "");
    for (let i = 0; i < 60; i++) ear.frame(frame(0.30));
    ear.reset();
    for (let i = 0; i < 60; i++) ear.frame(frame(0.30));
    expect(to.told.filter((line) => line === "stop")).toHaveLength(2);
  });
});

describe("4.6 the invention guard", () => {
  test("a recording that is all quiet is nothing, however long it ran", async () => {
    const quiet = new Int16Array(16_000);
    quiet.fill(Math.round(0.05 * 32768));
    const { to, ear } = room(async () => "Thank you.");
    await ear.said({ samples: quiet, ms: 1000, speechMs: 1000, peak: 0.05, gapMs: 0, endedBy: "pause", falseEnds: 0 });
    expect(to.told).toEqual(["nothing"]);
  });
});

describe("18 a microphone that stopped", () => {
  test("says nothing until a frame has arrived, so a room with no phone in it is quiet", () => {
    const { ear } = room(async () => "");
    expect(ear.silence(Date.now() + 10 * SILENCE_MS)).toBe(null);
  });

  test("frames with nothing in them are a capture that died", () => {
    const { ear } = room(async () => "");
    const at = Date.now();
    ear.frame(frame(0.3), at);
    ear.frame(frame(0), at + SILENCE_MS - 1);
    expect(ear.silence(at + SILENCE_MS - 1)).toBe(null);
    ear.frame(frame(0), at + SILENCE_MS + 10);
    expect(ear.silence(at + SILENCE_MS + 10)?.kind).toBe("silence");
  });

  test("a frame with any sound in it starts the clock again", () => {
    const { ear } = room(async () => "");
    const at = Date.now();
    ear.frame(frame(0), at);
    ear.frame(frame(0.001), at + SILENCE_MS + 10);
    expect(ear.silence(at + SILENCE_MS + 10)).toBe(null);
  });

  test("frames that stop arriving are a track that went away", () => {
    const { ear } = room(async () => "");
    const at = Date.now();
    ear.frame(frame(0.3), at);
    expect(ear.silence(at + SILENCE_MS + 10)?.kind).toBe("no frames");
  });

  test("a cut microphone is not a fault: the reset puts both clocks back", () => {
    const { ear } = room(async () => "");
    ear.frame(frame(0.3));
    ear.reset();
    expect(ear.silence(Date.now() + 10 * SILENCE_MS)).toBe(null);
  });
});

/**
 * Item 44 a threshold changed from the options menu reaches the detector
 * without a restart: the next frame reads it.
 */
describe("a threshold set while the ear runs (item 44)", () => {
  const speech = (frames: number) => Array.from({ length: frames }, () => frame(0.4));
  const quiet = (frames: number) => Array.from({ length: frames }, () => frame(0.001));

  test("the next frame reads the new pause", async () => {
    const { to, ear } = room(async () => "what is two plus two");
    ear.set({ endOfTurnPauseMs: 300 });
    // 400 ms of speech and 300 ms of quiet: the pause of 900 the ear was built with is still waiting
    for (const f of [...speech(20), ...quiet(15)]) ear.frame(f);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(to.told.at(-1)).toBe("heard what is two plus two");
  });

  test("the next utterance is judged against the new peak", async () => {
    let asked = 0;
    const { to, ear } = room(async () => { asked++; return "Thank you."; });
    ear.set({ minSpeechPeak: 0.5 });
    await ear.said(utterance(0.43));
    expect(asked).toBe(0);
    expect(to.told).toEqual(["nothing"]);
  });
});
