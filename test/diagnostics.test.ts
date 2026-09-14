import { describe, expect, test } from "bun:test";
import type { Utterance } from "../src/audio.ts";
import { Diagnostics } from "../src/diagnostics.ts";

const utterance = (over: Partial<Utterance> = {}): Utterance => ({
  samples: new Int16Array(0), ms: 3_000, speechMs: 2_400, peak: 0.3,
  gapMs: 2_000, endedBy: "pause", ...over,
});

describe("what the bridge remembers", () => {
  test("it keeps the measurements, not just the words", () => {
    const d = new Diagnostics();
    d.heard(utterance({ ms: 1_200, speechMs: 500, peak: 0.22, gapMs: 1_500 }), "Okay, it's...", 640, 1_000);
    const [event] = d.recent();
    expect(event).toEqual({
      kind: "heard", at: 1_000, text: "Okay, it's...", transcribeMs: 640,
      ms: 1_200, speechMs: 500, peak: 0.22, gapMs: 1_500, endedBy: "pause",
    });
  });

  test("it forgets the oldest rather than growing without end", () => {
    const d = new Diagnostics();
    for (let i = 0; i < 200; i++) d.note(`note ${i}`, i);
    const kept = d.recent(500);
    expect(kept.length).toBe(120);
    expect((kept[kept.length - 1] as { text: string }).text).toBe("note 199");
  });

  /**
   * The signature of the session that went wrong: short recordings, mostly
   * quiet, one end-of-turn pause apart. A summary that cannot tell that from a
   * healthy conversation is not worth keeping.
   */
  test("it can tell sentences cut in half from whole ones", () => {
    const chopped = new Diagnostics();
    for (let i = 0; i < 6; i++) chopped.heard(utterance({ ms: 1_100, speechMs: 400, gapMs: 1_500 }), "it was just, just,", 500, i);
    expect(chopped.summary().shortAndQuiet).toBe(6);
    expect(chopped.summary().medianMs).toBe(1_100);

    const whole = new Diagnostics();
    for (let i = 0; i < 6; i++) whole.heard(utterance({ ms: 4_000, speechMs: 3_200, gapMs: 3_000 }), "what does the serve command do", 500, i);
    expect(whole.summary().shortAndQuiet).toBe(0);
    expect(whole.summary().medianMs).toBe(4_000);
  });

  test("an empty transcript is counted, because it is what noise looks like", () => {
    const d = new Diagnostics();
    d.heard(utterance(), "", 200, 1);
    d.heard(utterance(), "hello", 200, 2);
    expect(d.summary().emptyTranscripts).toBe(1);
    expect(d.summary().utterances).toBe(2);
  });

  test("barge-ins are kept with the sound that caused them", () => {
    const d = new Diagnostics();
    d.barged(0.44, 400, 1);
    d.barged(0.52, 400, 2);
    expect(d.summary().bargeIns).toBe(2);
    expect(d.summary().medianBargeLevel).toBe(0.48);
  });
});
