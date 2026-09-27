import { describe, expect, test } from "bun:test";
import { Answer } from "../src/answer.ts";
import { Answers } from "../src/answers.ts";
import type { Channel } from "../src/channel.ts";

/** Answers over a mouth that says what it was given and drains when the test says. */
function rig() {
  const said: Array<{ sentence: string; id: number; asked: boolean }> = [];
  const channel = { tell() {} } as unknown as Channel;
  let drain = () => {};
  let cues = 0;
  const answers = new Answers(
    (id, asked, live) => new Answer(id, channel, 240, (sentence) => said.push({ sentence, id, asked }), live),
    () => new Promise<void>((resolve) => { drain = resolve; }),
    () => { cues++; },
  );
  return { answers, said, drain: () => drain(), cues: () => cues };
}

describe("which answer owns the mouth (11.9, 11.11, 15.15)", () => {
  test("an answer that still owns the mouth gets the done cue once it is said", async () => {
    const r = rig();
    const a = r.answers.ask();
    a.delta("All done");
    const ended = r.answers.end(a);
    r.drain();
    await ended;
    expect(r.cues()).toBe(1);
  });

  test("an old turn's end gives no cue once a new answer opened", async () => {
    const r = rig();
    const old = r.answers.ask();
    old.delta("All done");
    const ended = r.answers.end(old);
    r.answers.ask();
    r.drain();
    await ended;
    expect(r.cues()).toBe(0);
  });

  test("a question that takes the mouth silences the old answer, and its close clears nothing", () => {
    const r = rig();
    const old = r.answers.ask();
    r.answers.take();
    old.delta("Still talking.");
    old.end();
    expect(r.said).toEqual([]);
    expect(r.answers.close(old)).toBe(false);
    expect(r.answers.busy).toBe(true);
    expect(r.answers.current).toBe(old);
  });

  test("the rest a barge-in kept gets the cue, unless an answer opened while it played", async () => {
    const r = rig();
    let ended = r.answers.end();
    r.drain();
    await ended;
    expect(r.cues()).toBe(1);
    ended = r.answers.end();
    r.answers.unasked();
    r.drain();
    await ended;
    expect(r.cues()).toBe(1);
  });

  test("an unasked answer goes ahead of a hold, and the agent's words keep going to it", () => {
    const r = rig();
    const a = r.answers.unasked();
    expect(r.answers.unasked()).toBe(a);
    a.delta("News. ");
    a.delta("More");
    expect(r.said).toEqual([{ sentence: "News.", id: a.id, asked: false }]);
    expect(r.answers.busy).toBe(false);
    expect(r.answers.release()).toBe(a);
    expect(r.answers.current).toBeNull();
  });
});
