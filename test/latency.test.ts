import { describe, expect, test } from "bun:test";
import { Latency } from "../src/latency.ts";

/** One whole round trip, in milliseconds from an arbitrary zero. */
const PAUSE = 1_500;
function round(latency: Latency, endedAt: number, transcribeMs: number, answerMs: number): void {
  // the bridge notices the end of a turn one end-of-turn pause after it happens
  latency.spoke(endedAt, endedAt + PAUSE);
  latency.transcribed(endedAt + PAUSE + transcribeMs);
  latency.answered(endedAt + answerMs);
}

describe("latency (18.4)", () => {
  test("nothing measured says so rather than inventing a number", () => {
    expect(new Latency().report()).toBe("No round trip has been measured yet.");
    expect(new Latency().count).toBe(0);
  });
  test("the clock runs from the end of speech to the first audio", () => {
    const latency = new Latency();
    round(latency, 1_000, 300, 2_400);
    expect(latency.last).toEqual({ pauseMs: PAUSE, transcribeMs: 300, answerMs: 2_400 });
  });
  test("only the first sentence of an answer closes a round", () => {
    const latency = new Latency();
    round(latency, 0, 200, 1_000);
    latency.answered(9_000);
    expect(latency.count).toBe(1);
    expect(latency.last?.answerMs).toBe(1_000);
  });
  test("an utterance that never got an answer does not poison the next one", () => {
    const latency = new Latency();
    latency.spoke(0);
    round(latency, 5_000, 100, 900);
    expect(latency.count).toBe(1);
    expect(latency.last?.answerMs).toBe(900);
  });
  test("the median is the middle, so one tunnel does not become the story", () => {
    const latency = new Latency();
    for (const ms of [1_000, 1_200, 1_400, 30_000]) round(latency, 0, 100, ms);
    expect(latency.median()).toBe(1_300);
    expect(latency.worst()).toBe(30_000);
  });
  test("the report is sentences a person can hear once", () => {
    const latency = new Latency();
    round(latency, 0, 300, 2_400);
    expect(latency.report()).toBe(
      "The last answer took 2.4 seconds from when you stopped talking. 1.5 of that was the end of turn pause and 0.3 the transcription.",
    );
    round(latency, 0, 300, 2_600);
    expect(latency.report()).toContain("Over the last 2 the median is 2.5 and the worst was 2.6.");
  });
  test("the pause a setting decides is not charged to the engine", () => {
    const latency = new Latency();
    // 1.5 s of pause, 0.3 s of engine: the old split called all 1.8 transcription
    round(latency, 0, 300, 4_000);
    expect(latency.last?.pauseMs).toBe(1_500);
    expect(latency.last?.transcribeMs).toBe(300);
  });
});
