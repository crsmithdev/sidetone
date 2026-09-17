import { describe, expect, test } from "bun:test";
import { utteranceOf, type Utterance } from "../src/audio.ts";
import { Ear, type EarOptions } from "../src/ear.ts";

const OPTIONS: EarOptions = {
  sampleRate: 16_000,
  pauseMs: 900,
  onsetMs: 50,
  speechLevel: 0.02,
  bargeInLevel: 0.05,
  bargeInMs: 400,
  bargeInGapMs: 120,
  minSpeechPeak: 0.15,
  endOfTurnPauseMs: 900,
};

/** What the ear tells, written down instead of acted on. */
function listener(muted = false) {
  const told: string[] = [];
  return {
    told,
    isMuted: muted,
    latency: {
      spoke: () => told.push("spoke"),
      transcribed: () => told.push("transcribed"),
      barged: (level: number) => told.push(`barged ${level.toFixed(2)}`),
    },
    cue: (name: string) => told.push(`cue ${name}`),
    stopSpeaking: () => told.push("stop"),
    heard: async (text: string) => { told.push(`heard ${text}`); },
    heardNothing: () => told.push("nothing"),
  };
}

function utterance(peak: number): Utterance {
  return { samples: new Int16Array(160), ms: 1000, speechMs: 700, peak, gapMs: 1200, endedBy: "pause" };
}

/** A frame at a level, as the phone would send it. */
function frame(level: number, ms = 20): Int16Array {
  const samples = new Int16Array(Math.round((OPTIONS.sampleRate * ms) / 1000));
  samples.fill(Math.round(level * 32768));
  return samples;
}

describe("what is too quiet to have been a person (4.6)", () => {
  test("it costs no turn, and the passage comes back", async () => {
    const to = listener();
    let asked = 0;
    const ear = new Ear(to, async () => { asked++; return "Thank you."; }, OPTIONS, undefined, () => {});
    await ear.said(utterance(0.12));
    expect(asked).toBe(0);
    expect(to.told).toEqual(["nothing"]);
  });

  test("a real utterance is read, and the clock is told in order", async () => {
    const to = listener();
    const ear = new Ear(to, async () => "what is two plus two", OPTIONS, undefined, () => {});
    await ear.said(utterance(0.43));
    expect(to.told).toEqual(["spoke", "cue heard", "transcribed", "heard what is two plus two"]);
  });

  test("road noise that carried no words gives the passage back", async () => {
    const to = listener();
    const ear = new Ear(to, async () => "", OPTIONS, undefined, () => {});
    await ear.said(utterance(0.43));
    expect(to.told).toEqual(["spoke", "cue heard", "transcribed", "nothing"]);
  });

  test("an engine that throws is not a lost passage either", async () => {
    const to = listener();
    const notes: string[] = [];
    const ear = new Ear(to, async () => { throw new Error("worker died"); }, OPTIONS, {
      barged: () => {}, heard: () => {}, note: (text) => notes.push(text),
    }, () => {});
    await ear.said(utterance(0.43));
    expect(to.told).toEqual(["spoke", "cue heard", "nothing"]);
    expect(notes[0]).toContain("worker died");
  });
});

describe("the barge-in edge (11.3)", () => {
  const loud = () => frame(0.30);

  test("one crossing stops the speech once, not once per frame", async () => {
    const to = listener();
    const ear = new Ear(to, async () => "", OPTIONS, undefined, () => {});
    for (let i = 0; i < 60; i++) ear.frame(loud());
    expect(to.told.filter((line) => line === "stop")).toHaveLength(1);
  });

  test("a muted bridge keeps listening and stops shutting up (9.5)", async () => {
    const to = listener(true);
    const ear = new Ear(to, async () => "", OPTIONS, undefined, () => {});
    for (let i = 0; i < 60; i++) ear.frame(loud());
    expect(to.told).not.toContain("stop");
    expect(ear.bargingIn).toBe(false);
  });

  test("quiet frames are not a barge-in", async () => {
    const to = listener();
    const ear = new Ear(to, async () => "", OPTIONS, undefined, () => {});
    for (let i = 0; i < 60; i++) ear.frame(frame(0.005));
    expect(to.told).toEqual([]);
  });
});

describe("the phone cuts its microphone", () => {
  test("the hold goes with the half recording", async () => {
    const to = listener();
    const ear = new Ear(to, async () => "", OPTIONS, undefined, () => {});
    for (let i = 0; i < 60; i++) ear.frame(frame(0.30));
    expect(to.told).toContain("stop");
    // before this, nothing resolved the hold: no utterance could ever arrive,
    // and the rest of the answer waited for the ten-second backstop
    ear.reset();
    expect(to.told.at(-1)).toBe("nothing");
  });

  test("a cut clears the barge-in, so the next one is heard again", async () => {
    const to = listener();
    const ear = new Ear(to, async () => "", OPTIONS, undefined, () => {});
    for (let i = 0; i < 60; i++) ear.frame(frame(0.30));
    ear.reset();
    for (let i = 0; i < 60; i++) ear.frame(frame(0.30));
    expect(to.told.filter((line) => line === "stop")).toHaveLength(2);
  });
});

describe("a whole recording, from the desk (7.3)", () => {
  test("it is measured, not counted as it arrives", () => {
    const samples = new Int16Array(16_000);
    samples.fill(Math.round(0.4 * 32768), 0, 8_000);
    const said = utteranceOf({ sampleRate: 16_000, channels: 1, samples }, 0.02);
    expect(said.ms).toBe(1000);
    expect(said.speechMs).toBe(500);
    expect(said.peak).toBeCloseTo(0.4, 2);
    expect(said.gapMs).toBe(0);
  });

  test("the invention guard now applies at the desk too", async () => {
    const to = listener();
    const quiet = new Int16Array(16_000);
    quiet.fill(Math.round(0.05 * 32768));
    const ear = new Ear(to, async () => "Thank you.", OPTIONS, undefined, () => {});
    await ear.said(utteranceOf({ sampleRate: 16_000, channels: 1, samples: quiet }, 0.02));
    expect(to.told).toEqual(["nothing"]);
  });
});
