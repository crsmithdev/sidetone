import { describe, expect, test } from "bun:test";
import { Measures } from "../src/measures.ts";
import { ANNOUNCE_POLL_MS, Mouth, type Speaker } from "../src/mouth.ts";

/**
 * A speaker that can be made to block mid-sentence and to report a sentence
 * cut short, which is what a barge-in looks like from the mouth. Making a
 * sentence takes one tick, the way the engine takes a moment, so by the time
 * one sentence is made the next has usually been queued.
 */
function scripted(holdBackstopMs = 10_000, switchable = true) {
  const used: string[] = [];
  const played: string[] = [];
  const wavs: Array<string | null> = [];
  const cues: string[] = [];
  const started: Array<string | undefined> = [];
  let gate: (() => void) | null = null;
  let blocking = false;
  let whole = true;
  const speaker: Speaker = {
    async play(text, wav) {
      played.push(text);
      wavs.push(wav);
      if (blocking) await new Promise<void>((resolve) => { gate = resolve; });
      return whole;
    },
    cue(wav) { cues.push(wav); },
    track: () => null,
  };
  const made = {
    take: async (text: string) => `${text}.wav`,
    start: (text: string | undefined) => { started.push(text); },
    use: (voice: string) => { used.push(voice); return switchable; },
  };
  const measures = new Measures();
  const mouth = new Mouth(speaker, made, { file: (name) => `${name}.wav` }, measures, { holdBackstopMs, voiceChoices: { female: "f", male: "m" } });
  return {
    mouth, played, wavs, cues, started, used, measures, made,
    blockPlay: (on: boolean) => { blocking = on; },
    cutPlay: (on: boolean) => { whole = !on; },
    release: () => { gate?.(); gate = null; },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the hold (11.3)", () => {
  test("a barge-in keeps what is left, and a resume says it", async () => {
    const m = scripted();
    m.mouth.hold();
    m.mouth.say("one."); m.mouth.say("two.");
    await tick();
    expect(m.played).toEqual([]);
    expect(m.mouth.onHold).toBe(true);
    m.mouth.resume();
    await tick();
    expect(m.played).toEqual(["one.", "two."]);
  });

  test("a sentence the barge-in cut is said again from the start", async () => {
    const m = scripted();
    m.blockPlay(true);
    m.mouth.say("first."); m.mouth.say("second.");
    await tick();
    expect(m.played).toEqual(["first."]);
    // Chris starts talking while "first." is still playing
    m.cutPlay(true);
    m.mouth.hold();
    m.release();
    await tick();
    expect(m.played).toEqual(["first."]);
    m.blockPlay(false); m.cutPlay(false);
    m.mouth.resume();
    await tick();
    expect(m.played).toEqual(["first.", "first.", "second."]);
  });

  test("a transcription that never comes back is dropped by the backstop", async () => {
    const m = scripted(20);
    m.mouth.hold();
    m.mouth.say("the rest.");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(m.mouth.onHold).toBe(false);
    expect(m.played).toEqual([]);
  });

  test("a reply is heard over the hold, and the answer carries on after", async () => {
    const m = scripted();
    m.mouth.hold();
    m.mouth.say("the rest of the answer.");
    m.mouth.reply("Muted.");
    await tick();
    expect(m.played).toEqual(["Muted."]);
    m.mouth.resume();
    await tick();
    expect(m.played).toEqual(["Muted.", "the rest of the answer."]);
  });

  test("a reply that was cut goes back and waits, rather than spinning", async () => {
    // it used to be retried at once, cut at once and retried again for as long
    // as Chris kept talking: eighteen copies of one refusal in three seconds
    const m = scripted();
    m.cutPlay(true);
    m.mouth.hold();
    m.mouth.reply("Muted.");
    await tick();
    await tick();
    expect(m.played).toEqual(["Muted."]);
    m.cutPlay(false);
    m.mouth.resume();
    await tick();
    expect(m.played).toEqual(["Muted.", "Muted."]);
  });

  test("a cut sentence is never counted as something he heard", async () => {
    const m = scripted();
    m.cutPlay(true);
    // no hold: the discard came while the sentence was still playing, the way
    // a new question does it
    m.mouth.say("half a sen");
    await tick();
    expect(m.played).toEqual(["half a sen"]);
    expect(m.mouth.said).toEqual([]);
  });
});

describe("what a discard keeps (11.10)", () => {
  test("the rest is returned, and carry on says it once", async () => {
    const m = scripted();
    m.mouth.hold();
    m.mouth.say("two."); m.mouth.say("three.");
    expect(m.mouth.discard()).toEqual(["two.", "three."]);
    await tick();
    expect(m.played).toEqual([]);
    expect(m.mouth.carryOn()).toBe(true);
    await tick();
    expect(m.played).toEqual(["two.", "three."]);
    expect(m.mouth.carryOn()).toBe(false);
  });

  test("a barge-in on the replay holds it, and a discard keeps it again: nothing plays twice", async () => {
    // the drive of 18 September: the replay could not be stopped, and every
    // reply and every new answer waited behind it until it ran out
    const m = scripted();
    m.mouth.hold();
    m.mouth.say("two."); m.mouth.say("three.");
    m.mouth.discard();
    m.blockPlay(true);
    m.mouth.carryOn();
    await tick();
    expect(m.played).toEqual(["two."]);
    m.cutPlay(true);
    m.mouth.hold();
    m.release();
    await tick();
    m.cutPlay(false); m.blockPlay(false);
    expect(m.mouth.discard()).toEqual(["two.", "three."]);
    // the next answer is not behind the replay
    m.mouth.say("the next answer.");
    await tick();
    expect(m.played).toEqual(["two.", "the next answer."]);
    expect(m.mouth.said).toEqual(["the next answer."]);
  });

  test("a reply is heard over a held replay, and does not wait for it", async () => {
    const m = scripted();
    m.mouth.hold();
    m.mouth.say("two."); m.mouth.say("three."); m.mouth.say("four.");
    m.mouth.discard();
    m.blockPlay(true);
    m.mouth.carryOn();
    await tick();
    m.cutPlay(true);
    m.mouth.hold();
    m.release();
    await tick();
    m.cutPlay(false); m.blockPlay(false);
    m.mouth.reply("Stopped.");
    await tick();
    expect(m.played).toEqual(["two.", "Stopped."]);
  });

  test("carry on after a barge-in on the replay resumes from the cut sentence", async () => {
    const m = scripted();
    m.mouth.hold();
    m.mouth.say("two."); m.mouth.say("three.");
    m.mouth.discard();
    m.blockPlay(true);
    m.mouth.carryOn();
    await tick();
    m.cutPlay(true);
    m.mouth.hold();
    m.release();
    await tick();
    m.cutPlay(false); m.blockPlay(false);
    m.mouth.discard();
    expect(m.mouth.carryOn()).toBe(true);
    await tick();
    expect(m.played).toEqual(["two.", "two.", "three."]);
    expect(m.mouth.carryOn()).toBe(false);
  });

  test("a discard with nothing queued takes nothing, and keeps the last rest for carry on", () => {
    const m = scripted();
    m.mouth.hold();
    m.mouth.say("two.");
    expect(m.mouth.discard()).toEqual(["two."]);
    expect(m.mouth.discard()).toEqual([]);
    expect(m.mouth.carryOn()).toBe(true);
  });

  test("a hold with nothing behind it is not busy", () => {
    const m = scripted();
    m.mouth.hold();
    expect(m.mouth.busy).toBe(false);
    m.mouth.say("two.");
    expect(m.mouth.busy).toBe(true);
  });
});

describe("what he heard (9.4.5)", () => {
  test("a whole sentence counts, and a new turn starts the count again", async () => {
    const m = scripted();
    m.mouth.say("one.");
    await tick();
    expect(m.mouth.said).toEqual(["one."]);
    m.mouth.newTurn();
    expect(m.mouth.said).toEqual([]);
  });

  test("drained resolves once nothing is queued or playing", async () => {
    const m = scripted();
    m.mouth.say("one."); m.mouth.say("two.");
    await m.mouth.drained();
    expect(m.played).toEqual(["one.", "two."]);
  });
});

describe("the round trip's marks (18.4)", () => {
  /** A round open at the mouth: speech ended, the text went to the agent, its first word is back. */
  function open(m: ReturnType<typeof scripted>) {
    const now = Date.now();
    m.measures.speechEnded(now - 1_500, now);
    m.measures.transcribed(now);
    m.measures.firstDelta(now);
  }

  test("the first sentence of the answer is marked once, and a reply is not the answer", async () => {
    const m = scripted();
    open(m);
    m.mouth.reply("Carrying on.");
    await tick();
    // the reply closed the round with no sentence of the answer in it
    expect(m.measures.recent().find((e) => e.kind === "answered")).toMatchObject({ sentenceMs: 0 });
    open(m);
    m.mouth.say("one."); m.mouth.say("two.");
    await tick();
    const rounds = m.measures.recent().filter((e) => e.kind === "answered");
    expect(rounds).toHaveLength(2);
    expect((rounds[1] as { sentenceMs: number }).sentenceMs).toBeGreaterThanOrEqual(0);
  });

  test("what the engine spent on that sentence is on the round", async () => {
    const m = scripted();
    // an engine that takes a moment, like the real one
    (m as unknown as { made: { take: (t: string) => Promise<string> } }).made.take = async (t) => { await new Promise((r) => setTimeout(r, 15)); return t; };
    open(m);
    m.mouth.say("one.");
    await m.mouth.drained();
    const round = m.measures.recent().find((e) => e.kind === "answered") as { synthesisMs: number };
    expect(round.synthesisMs).toBeGreaterThanOrEqual(10);
  });

  test("a new turn starts the count again", async () => {
    const m = scripted();
    open(m);
    m.mouth.say("one."); await m.mouth.drained();
    m.mouth.newTurn();
    open(m);
    m.mouth.say("two."); await m.mouth.drained();
    expect(m.measures.recent().filter((e) => e.kind === "answered")).toHaveLength(2);
  });
});

describe("the voice off (11.12)", () => {
  test("nothing is made or played, the words still go, and they still count", async () => {
    const m = scripted();
    m.mouth.setVoice(false);
    m.mouth.say("the answer.");
    await tick();
    expect(m.played).toEqual(["the answer."]);
    expect(m.wavs).toEqual([null]);
    expect(m.started).toEqual([]);
    expect(m.mouth.said).toEqual(["the answer."]);
  });

  test("a cue is not played either", () => {
    const m = scripted();
    m.mouth.setVoice(false);
    m.mouth.cue("heard");
    expect(m.cues).toEqual([]);
  });
});

describe("a cue never plays over the voice (15)", () => {
  test("one transport shares one audio source, and it refuses two writers", async () => {
    const m = scripted();
    m.blockPlay(true);
    m.mouth.say("a long sentence being read out.");
    await tick();
    expect(m.played).toEqual(["a long sentence being read out."]);
    // the end-of-turn cue arrives while that sentence is still playing. On
    // 14 September this reached the transport and it threw
    // "InvalidState - failed to capture frame" into a live conversation.
    m.mouth.cue("heard");
    expect(m.cues).toEqual([]);
    m.blockPlay(false);
    m.release();
    await tick();
    m.mouth.cue("heard");
    expect(m.cues).toEqual(["heard.wav"]);
  });
});

/**
 * 11.6 the gap between two sentences. The mouth says one sentence at a time
 * and waits for each, so whatever the engine spends making a sentence lands in
 * the silence before it. The cloning voice spends three seconds. So the next
 * sentence is named as soon as this one is made, and the engine starts on it
 * while this one plays.
 */
describe("the next sentence is named before this one ends (11.6)", () => {
  test("each sentence names the one that follows it, and the last names nothing", async () => {
    const m = scripted();
    m.mouth.say("One."); m.mouth.say("Two."); m.mouth.say("Three.");
    await tick();
    expect(m.played).toEqual(["One.", "Two.", "Three."]);
    expect(m.started).toEqual(["Two.", "Three.", undefined]);
  });

  test("a sentence a barge-in cut is named again, not skipped past", async () => {
    const m = scripted();
    m.blockPlay(true);
    m.mouth.say("first."); m.mouth.say("second.");
    await tick();
    expect(m.played).toEqual(["first."]);
    expect(m.started).toEqual(["second."]);
    m.cutPlay(true);
    m.mouth.hold();
    m.release();
    await tick();
    m.blockPlay(false); m.cutPlay(false);
    m.mouth.resume();
    await tick();
    // the cut sentence plays again from the start, and still names the one after
    expect(m.played).toEqual(["first.", "first.", "second."]);
    expect(m.started).toEqual(["second.", "second.", undefined]);
  });
});

describe("the voice (4.9)", () => {
  test("a switch names the voice, says so, and hands the name back for the settings", () => {
    const m = scripted();
    expect(m.mouth.switchVoice("male")).toEqual({ said: "Switched to the male voice.", voice: "m" });
    expect(m.used).toEqual(["m"]);
  });
  test("an engine of one voice says so instead of pretending", () => {
    const m = scripted(undefined as never, false);
    expect(m.mouth.switchVoice("female")).toEqual({ said: "This engine has only the one voice.", voice: null });
  });
});

describe("an announcement from outside the conversation", () => {
  const poll = () => Bun.sleep(ANNOUNCE_POLL_MS + 50);

  test("it waits for the turn to end", async () => {
    const m = scripted();
    let turn = true;
    m.mouth.announce("Job research finished.", () => !turn);
    await poll();
    expect(m.played).toEqual([]);
    turn = false;
    await poll();
    expect(m.played).toEqual(["Job research finished."]);
  });

  test("it never goes over a sentence or into a hold", async () => {
    const m = scripted();
    m.blockPlay(true);
    m.mouth.say("one.");
    m.mouth.announce("Job research finished.", () => true);
    await poll();
    expect(m.played).toEqual(["one."]);
    m.blockPlay(false);
    m.mouth.hold();
    m.release();
    await poll();
    expect(m.played).toEqual(["one."]);
    m.mouth.resume();
    await poll();
    expect(m.played).toEqual(["one.", "Job research finished."]);
  });
});
