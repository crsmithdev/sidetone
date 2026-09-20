import { describe, expect, test } from "bun:test";
import type { Utterance } from "../src/audio.ts";
import { Measures } from "../src/measures.ts";

const said: Utterance = { samples: new Int16Array(0), ms: 2000, speechMs: 900, peak: 0.4, gapMs: 1500, endedBy: "pause", falseEnds: 0 };

/** One whole round: speech ends, it becomes text, the answer starts. */
function round(measures: Measures): void {
  measures.speechEnded(1_000, 2_500);
  measures.transcribed(2_800);
  measures.utterance(said, "what is two plus two", 300);
  measures.answering(3_400);
}

describe("one fact, told once", () => {
  test("a round reaches the record and the spoken report together", () => {
    const measures = new Measures();
    round(measures);
    expect(measures.recent().map((event) => event.kind)).toEqual(["heard", "answered"]);
    expect(measures.rounds()).toEqual({ rounds: 1, medianMs: 2400, worstMs: 2400 });
    expect(measures.report()).toBe("Last answer, 2.4 seconds. 1.5 of it was the end of turn pause.");
    const answered = measures.recent().find((event) => event.kind === "answered");
    expect(answered).toMatchObject({ answerMs: 2400, pauseMs: 1500, transcribeMs: 300 });
  });

  test("the three marks reach the record on the same event", () => {
    const measures = new Measures();
    measures.speechEnded(1_000, 2_500);
    measures.transcribed(2_800);
    measures.firstDelta(3_000);
    measures.firstSentence(3_200);
    measures.synthesized(150);
    measures.answering(3_400);
    const answered = measures.recent().find((event) => event.kind === "answered");
    expect(answered).toMatchObject({ answerMs: 2400, agentMs: 200, sentenceMs: 200, synthesisMs: 150 });
  });

  test("a barge-in reaches both, from one telling", () => {
    const measures = new Measures();
    measures.bargeIn(0.334, 400);
    measures.bargeInWas("nothing");
    round(measures);
    expect(measures.recent().map((event) => event.kind)).toEqual(["barged", "heard", "answered"]);
    expect(measures.report()).toContain("1 barge-ins, 1 of them nothing");
  });

  test("the sink is given every event as it happens", () => {
    const seen: string[] = [];
    const measures = new Measures((event) => seen.push(event.kind));
    round(measures);
    measures.spoken("Four.", true);
    measures.matched("sidetone stats", "stats");
    measures.note("the engine coughed");
    expect(seen).toEqual(["heard", "answered", "spoke", "matched", "note"]);
  });
});

describe("out of order (18.4)", () => {
  test("a second sentence of the same answer closes nothing", () => {
    const measures = new Measures();
    round(measures);
    expect(measures.answering(4_000)).toBeNull();
    expect(measures.rounds().rounds).toBe(1);
    expect(measures.recent().filter((event) => event.kind === "answered")).toHaveLength(1);
  });

  test("an answer with no question before it is not a round", () => {
    const measures = new Measures();
    expect(measures.answering(3_000)).toBeNull();
    expect(measures.recent()).toEqual([]);
    expect(measures.report()).toBe("No round trip has been measured yet.");
  });

  test("text that arrives before any speech is ignored, and the next round is clean", () => {
    const measures = new Measures();
    measures.transcribed(2_000);
    round(measures);
    expect(measures.rounds()).toMatchObject({ rounds: 1, medianMs: 2400 });
  });

  test("a barge-in nobody resolved stays unresolved, and is not counted as nothing", () => {
    const measures = new Measures();
    measures.bargeIn(0.4, 400);
    measures.bargeIn(0.5, 500);
    measures.bargeInWas("speech");
    round(measures);
    // the second one is the open one; the first stays as it was
    expect(measures.report()).toContain("2 barge-ins, 0 of them nothing");
  });
});
