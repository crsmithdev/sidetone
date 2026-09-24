import { describe, expect, test } from "bun:test";
import type { Event } from "../src/diagnostics.ts";
import { echoOf, likeness, verdict } from "../src/echo.ts";

/**
 * 18.10 the check that would have caught the volume slider of 21 September on
 * its first real run, instead of on a drive.
 */
describe("hearing itself (18.10)", () => {
  const spoken = ["I will look at the logs now.", "The service restarted about nine minutes ago."];

  test("the microphone hearing the speaker is an echo", () => {
    // what whisper writes from the room is the sentence, give or take the punctuation
    expect(echoOf("the service restarted about nine minutes ago", spoken))
      .toBe("The service restarted about nine minutes ago.");
  });

  test("a few words wrong is still an echo, because a room is not a wire", () => {
    expect(echoOf("the service restarted about nine minutes uh go", spoken))
      .toBe("The service restarted about nine minutes ago.");
  });

  test("what Chris actually says is not", () => {
    expect(echoOf("what did the logs say about the restart", spoken)).toBeNull();
    expect(echoOf("read me the last part again", spoken)).toBeNull();
  });

  test("a short utterance is never an echo, because the bridge says those words too", () => {
    // "stop", "carry on", "say again" are Chris's commands and the bridge's own replies
    expect(echoOf("carry on", ["Carry on.", "Stopped."])).toBeNull();
    expect(echoOf("stop", ["Stopped."])).toBeNull();
  });

  test("nothing said yet is nothing to echo", () => {
    expect(echoOf("the service restarted about nine minutes ago", [])).toBeNull();
  });

  test("the newest sentence wins when two could match", () => {
    expect(echoOf("i will look at the logs now", ["I will look at the logs now.", "I will look at the logs now, again."]))
      .toBe("I will look at the logs now, again.");
  });
});

/**
 * 18.10 a garbled echo: the engine splits and joins the words, so fewer than
 * 70 % of them are in the sentence, but the letters still are.
 */
describe("a garbled echo (18.10)", () => {
  // what the voice said on 23 September while the passage about Ilse played
  const ilse = [
    "On the night of the storm the wind rose before sunset.",
    "By eight the waves were breaking over the landing, and by ten they reached the door of the keeper's cottage.",
    "Ilse carried the logbook up the tower, because she had decided that if the sea took the cottage, it would not take the record.",
  ];

  test("the words split and joined in other places are still an echo", () => {
    // made from the last sentence: half of the words match, and nearly every letter does
    expect(echoOf("ilsa carried the log book up the tower be cause she had decid that if these ear took the cot age", ilse))
      .toBe(ilse[2]!);
  });

  test("the letters are compared with the closest stretch of the sentence, not the whole of it", () => {
    expect(likeness("I'll open the new screen shot.", "I'll open the new screenshot.")).toBe(1);
    expect(likeness("the waves were breaking", ilse[1]!)).toBe(1);
  });

  test("what Chris said over the voice on 23 September is not an echo", () => {
    // from the record: each scored 0.65 or less against the sentence it came closest to
    expect(echoOf("Agree with the recommendation.", ["I found how the bubble is built, and I have a recommendation."])).toBeNull();
    expect(echoOf("That's an argument level factor.", ["I'll check the barge-in level for that turn."])).toBeNull();
  });

  test("the real case of 23 September is not caught by its words: they are not the passage's", () => {
    // The ear heard 51 s of the passage and the engine wrote five words for it.
    // Its letters come 0.55 close to the nearest sentence, and what Chris
    // really said over the voice came as close as 0.65, so the words cannot
    // tell this one apart. It needs a signal other than the text.
    expect(likeness("and we'll melt the breath.", ilse[1]!)).toBeLessThan(0.6);
    expect(echoOf("and we'll melt the breath.", ilse)).toBeNull();
  });
});

/**
 * 18.10.3 the ear returns one utterance for a run of sentences, and no single
 * sentence holds enough of it. This is the car of 23 September, where the whole
 * check passage came back through the microphone and the check called it
 * somebody talking.
 */
describe("an echo of several sentences at once (18.10.3)", () => {
  const passage = [
    "This is the echo check, and nobody needs to answer it.",
    "The bridge is talking to itself to find out whether the phone can hear it.",
    "If the microphone brings these words back, the echo canceller is not holding.",
    "A pass means the room stayed quiet while every one of these sentences played.",
  ];
  // what the microphone brought back in the car, word for word from the record
  const back = "This is the echo chat and nobody needs to answer it. The bridge is talking to itself to "
    + "find out whether the phone can hear it. If the microphone brings these words back, the echo "
    + "counselor is not holding. The pass leaves the room stay quiet while every one of these "
    + "sentences played.";

  test("no single sentence holds enough of it", () => {
    for (const sentence of passage) expect(likeness(back, sentence)).toBeLessThan(0.7);
  });

  test("the run of sentences together is the echo", () => {
    expect(echoOf(back, passage)).toBe(passage.join(" "));
  });

  test("one sentence of the run still matches that sentence", () => {
    expect(echoOf("if the microphone brings these words back the echo counselor is not holding", passage))
      .toBe(passage[2]!);
  });
});

/**
 * 18.13 the echo check reads the record of a passage the bridge said into a
 * quiet room. The events are what the record holds; the phone is not here.
 */
describe("the echo check (18.13)", () => {
  const passage = ["This is the echo check, and nobody needs to answer it.", "A pass means the room stayed quiet while it played."];
  const spoke = (text: string, whole = true, at = 1_000): Event => ({ kind: "spoke", at, text, whole });
  const heard = (text: string, at = 900): Event => ({
    kind: "heard", at, text, transcribeMs: 0, ms: 2_000, speechMs: 1_500, peak: 0.3, gapMs: 0, endedBy: "pause", falseEnds: 0,
  });

  test("a room that stayed quiet passes", () => {
    expect(verdict([spoke(passage[0]!), spoke(passage[1]!), heard("")], passage, 5_000).code).toBe(0);
  });

  test("the passage coming back through the microphone fails", () => {
    // the volume slider of 21 September, as the record would have shown it
    const result = verdict([spoke(passage[0]!), heard("this is the echo check and nobody needs to answer")], passage, 5_000);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain("an echo");
  });

  test("a sentence a barge-in cut short fails", () => {
    expect(verdict([spoke(passage[0]!, false)], passage, 5_000).code).toBe(1);
  });

  test("a barge-in with nobody talking fails", () => {
    expect(verdict([{ kind: "barged", at: 500, level: 0.3, heldMs: 400 }, spoke(passage[0]!)], passage, 5_000).code).toBe(1);
  });

  test("the whole passage in one utterance fails, it is not somebody talking (18.10.3)", () => {
    const back = "This is the echo chat and nobody needs to answer it. A pass leaves the room stay quiet.";
    const result = verdict([spoke(passage[0]!), spoke(passage[1]!), heard(back)], passage, 5_000);
    expect(result.code).toBe(1);
    expect(result.lines[0]).toContain("an echo");
  });

  test("somebody talking cannot tell", () => {
    expect(verdict([heard("can you turn left at the next light")], passage, 5_000).code).toBe(2);
  });

  test("what comes after the check does not count", () => {
    expect(verdict([heard("this is the echo check and nobody needs to answer", 9_000)], passage, 5_000).code).toBe(0);
  });
});
