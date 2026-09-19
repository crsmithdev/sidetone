import { describe, expect, test } from "bun:test";
import type { Event } from "../src/diagnostics.ts";
import { PASSAGE, SCRIPT, score, wordAccuracy } from "../src/scorecard.ts";

const heard = (text: string, over: Partial<{ ms: number; speechMs: number; peak: number; transcribeMs: number }> = {}): Event => ({
  kind: "heard", at: 0, text, transcribeMs: 200,
  ms: 3_000, speechMs: 2_000, peak: 0.45, gapMs: 2_000, endedBy: "pause", ...over,
});
const matched = (said: string, became: string): Event => ({ kind: "matched", at: 0, said, became });

/** A session where everything worked: the card read straight through. */
function good(): Event[] {
  return [
    ...PASSAGE.flatMap((line) => [heard(line), matched(line, "speech")]),
    ...SCRIPT.flatMap((step) => [heard(step.say), matched(step.say, step.expect)]),
  ];
}

describe("word accuracy", () => {
  test("it scores what came back, not the punctuation", () => {
    expect(wordAccuracy("The keeper rang the bell.", "the keeper rang the bell")).toBe(1);
    expect(wordAccuracy("one two three four", "one two")).toBe(0.5);
    expect(wordAccuracy("one two", "")).toBe(0);
  });
});

describe("scoring a session", () => {
  test("a clean run scores clean", () => {
    const card = score(good());
    expect(card.commands.fired).toBe(SCRIPT.length);
    expect(card.commands.missed).toEqual([]);
    expect(card.passage.whole).toBe(PASSAGE.length);
    expect(card.passage.fragments).toBe(0);
    expect(card.invented).toBe(0);
  });

  /** The session of 14 September, in the shape it actually arrived. */
  test("it catches a command that reached the agent instead", () => {
    const card = score([
      heard("Hey, bridge."), matched("Hey, bridge.", "waiting for the command"),
      heard("Mute."), matched("Mute.", "speech"),
    ]);
    expect(card.commands.missed).toContain("mute");
    expect(card.commands.wrong.length).toBe(0);   // "Mute." alone carries no wake word
    const withWake = score([heard("Hey, BridgeMute."), matched("Hey, BridgeMute.", "speech")]);
    expect(withWake.commands.wrong.map((w) => w.said)).toEqual(["Hey, BridgeMute."]);
  });

  test("it catches a passage arriving in pieces", () => {
    const chopped = PASSAGE.flatMap((line) => {
      const half = Math.ceil(line.split(" ").length / 2);
      const words = line.split(" ");
      return [heard(words.slice(0, half).join(" "), { ms: 1_100 }), heard(words.slice(half).join(" "), { ms: 1_100 })];
    });
    const card = score(chopped);
    expect(card.passage.utterances).toBe(6);
    expect(card.passage.fragments).toBe(3);
    expect(card.passage.whole).toBeLessThan(PASSAGE.length);
  });

  test("it catches a turn nobody asked for", () => {
    // 14 September exactly: "Thank you." peaked at 0.12 among speech at 0.43 to 0.55
    const session = [
      heard("Thank you.", { speechMs: 400, peak: 0.12 }),
      heard("Hey bridge, mute", { peak: 0.48 }),
      heard("Testing, can you hear me?", { peak: 0.43 }),
      heard("Testing once more, can you hear me?", { peak: 0.55 }),
      heard("Hey bridge, unmute", { peak: 0.49 }),
    ];
    expect(score(session).invented).toBe(1);
  });

  test("a quiet session is not one long invention", () => {
    // the same words from a quieter recording: every peak near the median, so
    // none of them stands out. An absolute threshold called all of these
    // inventions, which is how that rule was caught.
    const quiet = [0.19, 0.20, 0.18, 0.21, 0.19, 0.20].map((peak) => heard("the keeper rang the bell", { peak }));
    expect(score(quiet).invented).toBe(0);
  });

  test("it says nothing about inventions until it has seen enough", () => {
    expect(score([heard("Thank you.", { peak: 0.12 })]).invented).toBe(0);
  });

  test("an empty transcript is not an invention", () => {
    expect(score([heard("", { speechMs: 100, peak: 0.02 })]).invented).toBe(0);
    expect(score([heard("", { speechMs: 100, peak: 0.02 })]).heard.empty).toBe(1);
  });

  test("a missed command is named, so the next run has something to aim at", () => {
    const partial = good().filter((e) => !(e.kind === "matched" && e.became === "tonesOff"));
    expect(score(partial).commands.missed).toEqual(["tonesOff"]);
  });
});

describe("the commands, in the order the card asks for them", () => {
  /**
   * The card fires mute and unmute to read the passage and asks for stats
   * while talking over the answer, all outside the script. Counted by name,
   * those stood in for a step that never fired, and the one step the card
   * exists to measure -- the wake-word hold at step 8 -- could not fail.
   */
  test("a step that never fired is missed, whatever fired elsewhere", () => {
    const drive = [
      heard("the keeper rang the bell"), matched("hey bridge, mute", "mute"), matched("hey bridge, unmute", "unmute"),
      matched("hey bridge, stats", "stats"), matched("hey bridge, tones off", "tonesOff"),
      matched("hey bridge, tones on", "tonesOn"), matched("hey bridge, recap", "where"),
      matched("hey bridge, say again", "restate"),
      matched("hey bridge, mute", "mute"), matched("hey bridge, unmute", "unmute"),
      // step 8, the wake-word hold, never fires
      matched("hey bridge, unmute", "unmute"),
      matched("hey bridge, stats", "stats"),
    ];
    const card = score(drive);
    expect(card.commands.missed).toEqual(["mute"]);
    expect(card.commands.fired).toBe(8);
  });

  /**
   * Step 1 is stats and the card asks for stats again at the end, while
   * talking over the answer. Taking the first firing after the one before it
   * matched that last one, left nothing for the eight steps between, and
   * turned a drive that fired eight of nine into 1 of 9.
   */
  test("a step that fires again later does not swallow the steps between", () => {
    const drive = [
      heard("the keeper rang the bell"), matched("hey bridge, mute", "mute"), matched("hey bridge, unmute", "unmute"),
      // step 1, stats, never fires
      matched("hey bridge, tones off", "tonesOff"), matched("hey bridge, tones on", "tonesOn"),
      matched("hey bridge, recap", "where"), matched("hey bridge, say again", "restate"),
      matched("hey bridge, mute", "mute"), matched("hey bridge, unmute", "unmute"),
      matched("hey bridge, mute", "mute"), matched("hey bridge, unmute", "unmute"),
      matched("hey bridge, stats", "stats"),
    ];
    const card = score(drive);
    expect(card.commands.missed).toEqual(["stats"]);
    expect(card.commands.fired).toBe(8);
  });

  test("a missed step does not slide the ones after it", () => {
    const drive = SCRIPT.filter((step) => step.expect !== "tonesOn")
      .map((step) => matched(step.say, step.expect));
    expect(score(drive).commands.missed).toEqual(["tonesOn"]);
  });
});

describe("the round trip", () => {
  const answered = (answerMs: number, marks: Partial<{ agentMs: number; sentenceMs: number; synthesisMs: number }> = {}): Event =>
    ({ kind: "answered", at: 0, answerMs, pauseMs: 1_500, transcribeMs: 200, agentMs: 0, sentenceMs: 0, synthesisMs: 0, ...marks });

  test("it reports the middle and the worst of the answers", () => {
    const card = score([heard("hello"), answered(1_800), answered(1_600), answered(3_500)]);
    expect(card.roundTrip).toEqual({ rounds: 3, medianMs: 1_800, worstMs: 3_500, medianAgentMs: 0, medianSentenceMs: 0, medianSynthesisMs: 0 });
  });

  test("a drive with no answer in it reports nothing rather than zero-ish", () => {
    const card = score([heard("hello")]);
    expect(card.roundTrip).toEqual({ rounds: 0, medianMs: 0, worstMs: 0, medianAgentMs: 0, medianSentenceMs: 0, medianSynthesisMs: 0 });
  });

  test("the split is the median over the rounds that carry the mark", () => {
    const card = score([
      answered(4_000, { agentMs: 2_000, sentenceMs: 300, synthesisMs: 120 }),
      answered(6_000, { agentMs: 3_000, sentenceMs: 500, synthesisMs: 160 }),
      // a command's reply, or the desk: the marks were never made
      answered(2_000),
    ]);
    expect(card.roundTrip).toMatchObject({ rounds: 3, medianMs: 4_000, medianAgentMs: 2_500, medianSentenceMs: 400, medianSynthesisMs: 140 });
  });

  test("a record from before the marks existed scores without them", () => {
    // the field is absent, not zero, on those lines
    const old = { kind: "answered", at: 0, answerMs: 5_000, pauseMs: 1_500, transcribeMs: 300 } as unknown as Event;
    expect(score([old]).roundTrip).toMatchObject({ rounds: 1, medianMs: 5_000, medianAgentMs: 0 });
  });
});
