import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Latency, type TimedRound } from "../src/latency.ts";
import { parseLine } from "../src/protocol.ts";

/** One whole round trip, in milliseconds from an arbitrary zero. */
const PAUSE = 1_500;
function round(latency: Latency, endedAt: number, transcribeMs: number, answerMs: number): void {
  // the bridge notices the end of a turn one end-of-turn pause after it happens
  latency.speechEnded(endedAt, endedAt + PAUSE);
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
    expect(latency.last).toEqual({ pauseMs: PAUSE, transcribeMs: 300, answerMs: 2_400, agentMs: 0, sentenceMs: 0, synthesisMs: 0 });
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
    latency.speechEnded(0);
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
    // short sentences: one of these ran fourteen seconds spoken aloud
    expect(latency.report()).toBe("Last answer, 2.4 seconds. 1.5 of it was the end of turn pause.");
    round(latency, 0, 300, 2_600);
    expect(latency.report()).toContain("Median 2.5, worst 2.6.");
    for (const sentence of latency.report().split(". ")) {
      expect(sentence.split(/\s+/).length).toBeLessThan(12);
    }
  });
  test("the rest of the round is split three ways when the marks are made", () => {
    const latency = new Latency();
    latency.speechEnded(0, PAUSE);
    latency.transcribed(PAUSE + 300);        // the text went to the agent
    latency.firstDelta(PAUSE + 300 + 900);   // its first word came back
    latency.firstSentence(PAUSE + 300 + 900 + 400);
    latency.synthesized(150);
    latency.answered(PAUSE + 300 + 900 + 400 + 150);
    expect(latency.last).toMatchObject({ transcribeMs: 300, agentMs: 900, sentenceMs: 400, synthesisMs: 150, answerMs: 3_250 });
  });

  test("a mark with no round open, or made twice, changes nothing", () => {
    const latency = new Latency();
    latency.firstDelta(10);
    latency.synthesized(999);
    latency.speechEnded(0, PAUSE);
    latency.transcribed(PAUSE + 100);
    latency.firstDelta(PAUSE + 600);
    latency.firstDelta(PAUSE + 5_000);      // a later delta is not the first
    latency.synthesized(120);
    latency.synthesized(3_000);             // the second sentence's synthesis is not this round's
    latency.answered(PAUSE + 900);
    expect(latency.last).toMatchObject({ agentMs: 500, sentenceMs: 0, synthesisMs: 120 });
    expect(latency.count).toBe(1);
  });

  test("the report speaks the split when the marks were made, and not when they were not", () => {
    const latency = new Latency();
    latency.speechEnded(0, PAUSE);
    latency.transcribed(PAUSE + 300);
    latency.firstDelta(PAUSE + 300 + 800);
    latency.firstSentence(PAUSE + 300 + 800 + 250);
    latency.synthesized(100);
    latency.answered(PAUSE + 300 + 800 + 250 + 100);
    expect(latency.report()).toContain("The agent took 0.8, the first sentence 0.3, the voice 0.1.");
    // a command's reply closes a round with no marks, and says nothing of them
    round(latency, 10_000, 200, 1_000);
    expect(latency.report()).not.toContain("The agent took");
  });

  test("the pause a setting decides is not charged to the engine", () => {
    const latency = new Latency();
    // 1.5 s of pause, 0.3 s of engine: the old split called all 1.8 transcription
    round(latency, 0, 300, 4_000);
    expect(latency.last?.pauseMs).toBe(1_500);
    expect(latency.last?.transcribeMs).toBe(300);
  });
});

describe("the agent's timings (18.4.1)", () => {
  /** A real stream, one line every 10 ms after the round opened, told to the round as the session tells it. */
  function replay(name: string): TimedRound {
    const lines = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").split("\n").filter(Boolean);
    const latency = new Latency();
    latency.speechEnded(0, 1_500);
    latency.transcribed(1_800);
    lines.forEach((line, i) => { for (const event of parseLine(line)) latency.agent(event, 2_000 + i * 10); });
    return latency.answered(2_000 + lines.length * 10)!;
  }
  const at = (name: string, match: string) =>
    readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8").split("\n").filter(Boolean).findIndex((line) => line.includes(match));

  test("a turn that thinks, runs a tool, then speaks", () => {
    const round = replay("stream-think-tool.ndjson");
    const requestMs = (at("stream-think-tool.ndjson", '"message_start"') - at("stream-think-tool.ndjson", '"requesting"')) * 10;
    expect(round).toMatchObject({
      inputTokens: 2, cacheReadTokens: 10221, cacheCreationTokens: 16037,
      thinkingTokens: 182, firstEvent: "thinking", toolsBeforeText: 1, requestMs,
    });
  });

  test("the thinking of every message before the first word counts, and the usage is the first request's", () => {
    const round = replay("stream-inject-tool.ndjson");
    expect(round).toMatchObject({ cacheReadTokens: 8253, cacheCreationTokens: 15879, thinkingTokens: 242, firstEvent: "tool_use", toolsBeforeText: 1 });
  });

  test("a turn that speaks at once has no thinking estimate, not a zero", () => {
    const round = replay("stream-pong.ndjson");
    expect(round).toMatchObject({ firstEvent: "text", toolsBeforeText: 0 });
    expect(round.cacheReadTokens).toBeGreaterThan(0);
    expect("thinkingTokens" in round).toBe(false);
  });

  test("a round with no stream, such as a command's reply, has none of them", () => {
    const latency = new Latency();
    round(latency, 0, 300, 2_000);
    const keys = Object.keys(latency.last!);
    for (const key of ["inputTokens", "cacheReadTokens", "cacheCreationTokens", "thinkingTokens", "firstEvent", "toolsBeforeText", "requestMs"]) expect(keys).not.toContain(key);
  });

  test("the stream before the round opened, and after the first word, is not this round's", () => {
    const latency = new Latency();
    latency.agent({ kind: "requesting" }, 0);
    latency.speechEnded(100, 1_600);
    latency.agent({ kind: "requesting" }, 2_000);
    latency.agent({ kind: "messageStart", usage: { inputTokens: 3, outputTokens: 1, cacheReadTokens: 900, cacheCreationTokens: 20 } }, 2_700);
    latency.agent({ kind: "blockStart", type: "text" }, 2_800);
    latency.agent({ kind: "delta", text: "Yes." }, 2_900);
    latency.agent({ kind: "thinking", tokens: 400 }, 3_000);
    latency.agent({ kind: "blockStart", type: "tool_use" }, 3_100);
    latency.agent({ kind: "messageStart", usage: { inputTokens: 5, outputTokens: 1, cacheReadTokens: 1, cacheCreationTokens: 1 } }, 3_200);
    const round = latency.answered(3_500)!;
    expect(round).toMatchObject({ requestMs: 700, inputTokens: 3, cacheReadTokens: 900, cacheCreationTokens: 20, firstEvent: "text", toolsBeforeText: 0 });
    expect("thinkingTokens" in round).toBe(false);
  });
});
