import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Measures } from "../src/measures.ts";
import { ANNOUNCE_POLL_MS, Mouth, type Speaker } from "../src/mouth.ts";
import { DEFAULTS } from "../src/config.ts";
import { LocalVoice, SpokenAhead, type TextToSpeech } from "../src/speech.ts";

/**
 * A speaker that can be made to block mid-sentence and to report a sentence
 * cut short, which is what a barge-in looks like from the mouth. Making a
 * sentence takes one tick, the way the engine takes a moment, so by the time
 * one sentence is made the next has usually been queued.
 */
function scripted(holdBackstopMs = 10_000, switchable = true, ahead?: SpokenAhead) {
  const used: string[] = [];
  const played: string[] = [];
  const wavs: Array<string | null> = [];
  const cues: string[] = [];
  const cuts: Array<() => boolean> = [];
  const started: Array<string | undefined> = [];
  let gate: (() => void) | null = null;
  let blocking = false;
  let whole = true;
  const speaker: Speaker = {
    async play(text, wav, cut) {
      played.push(text);
      wavs.push(wav);
      cuts.push(cut);
      if (blocking) await new Promise<void>((resolve) => { gate = resolve; });
      // the real speaker plays nothing for no wav, and stops between frames for a cut
      return wav === null || (whole && !cut());
    },
    cue(wav, cut) { cues.push(wav); cuts.push(cut); },
    track: () => null,
  };
  const made = ahead ?? {
    take: async (text: string) => `${text}.wav`,
    start: (text: string | undefined) => { started.push(text); },
    use: (voice: string) => { used.push(voice); return switchable; },
    times: () => undefined,
    keptClip: () => null,
  };
  const measures = new Measures();
  const mouth = new Mouth(speaker, made, { file: (name) => `${name}.wav` }, measures, { holdBackstopMs, voiceChoices: { female: "f", male: "m" } });
  return {
    mouth, played, wavs, cues, cuts, started, used, measures, made,
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

/** A mouth over a real `SpokenAhead`, with an engine that writes each sentence to the scratch and counts it. */
function voiced() {
  const asked: string[] = [];
  const tts: TextToSpeech = {
    start: async () => {},
    sampleRate: 24_000,
    switchable: true,
    voice: "test",
    use: () => {},
    synthesize: async (text, wav) => { asked.push(text); await Bun.write(wav, text); return wav; },
    stop: () => {},
  };
  const scratch = mkdtempSync(join(tmpdir(), "mouth-"));
  return { ...scripted(10_000, true, new SpokenAhead(tts, scratch)), asked, scratch };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

/** "first." plays, "second." is made ahead, and a barge-in cuts "first.". */
async function cutFirst(m: ReturnType<typeof voiced>) {
  m.blockPlay(true);
  m.mouth.say("first."); m.mouth.say("second.");
  await settle();
  m.cutPlay(true);
  m.mouth.hold();
  m.release();
  await settle();
  m.blockPlay(false); m.cutPlay(false);
}

describe("a resume plays the clip it cut (11.3, 11.6)", () => {
  test("the engine is asked for neither the cut sentence nor the one made ahead again", async () => {
    const m = voiced();
    await cutFirst(m);
    m.mouth.resume();
    await m.mouth.drained();
    expect(m.played).toEqual(["first.", "first.", "second."]);
    expect(m.wavs[1]).toBe(m.wavs[0]);
    expect(m.asked).toEqual(["first.", "second."]);
  });

  test("the clips go once the next sentence is taken, and none is left behind", async () => {
    const m = voiced();
    await cutFirst(m);
    m.mouth.resume();
    await m.mouth.drained();
    m.mouth.say("third.");
    await m.mouth.drained();
    await settle();
    expect(readdirSync(m.scratch)).toEqual([basename(m.wavs[3]!)]);
  });

  test("a discard drops the cut clip and the one made ahead, and the next answer is made fresh", async () => {
    const m = voiced();
    await cutFirst(m);
    m.mouth.discard();
    m.mouth.say("other.");
    await m.mouth.drained();
    await settle();
    expect(m.asked).toEqual(["first.", "second.", "other."]);
    expect(readdirSync(m.scratch)).toEqual([basename(m.wavs[1]!)]);
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

  // 15.15 the cue at the end of the speech waits on this: a held sentence is
  // still to be said, so a hold is not the end
  test("drained waits through a hold, and resolves when the held rest is said or dropped", async () => {
    const m = scripted();
    m.mouth.hold();
    m.mouth.say("the rest.");
    let drained = false;
    void m.mouth.drained().then(() => { drained = true; });
    await tick();
    expect(drained).toBe(false);
    m.mouth.resume();
    await tick();
    expect(drained).toBe(true);
    expect(m.played).toEqual(["the rest."]);
    m.mouth.hold();
    m.mouth.say("more.");
    drained = false;
    void m.mouth.drained().then(() => { drained = true; });
    await tick();
    expect(drained).toBe(false);
    m.mouth.discard();
    await tick();
    expect(drained).toBe(true);
    expect(m.played).toEqual(["the rest."]);
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

  /**
   * A worker in Bun that speaks the Python workers' protocol: a ready line,
   * then one reply a request with the timings `reply` names. No model loads.
   */
  async function standIn(reply: Record<string, number>) {
    const dir = mkdtempSync(join(tmpdir(), "worker-"));
    const script = join(dir, "worker.ts");
    await Bun.write(script, `
      const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
      out({ ready: true, sample_rate: 24000 });
      for await (const line of console) {
        const asked = JSON.parse(line);
        await Bun.write(asked.wav, asked.text);
        out({ wav: asked.wav, ...${JSON.stringify(reply)} });
      }
    `);
    return new LocalVoice({ switchable: true, voices: DEFAULTS, worker: () => ({ bin: process.execPath, args: [script] }) }, DEFAULTS, dir);
  }

  test("what the worker says the sentence cost reaches the record", async () => {
    const voice = await standIn({ seconds: 1.234, tokens: 70, t3_seconds: 0.9, s3gen_seconds: 0.25, watermark_seconds: 0.05 });
    await voice.start();
    try {
      const m = scripted(10_000, true, new SpokenAhead(voice, mkdtempSync(join(tmpdir(), "mouth-"))));
      open(m);
      m.mouth.say("one."); m.mouth.say("two.");
      await m.mouth.drained();
      const rounds = m.measures.recent().filter((e) => e.kind === "answered");
      expect(rounds).toHaveLength(1);
      expect(rounds[0]).toMatchObject({ workerMs: 1234, speechTokens: 70, t3Ms: 900, s3genMs: 250, watermarkMs: 50 });
    } finally { voice.stop(); }
  });

  test("a worker that gives only the whole time gives the record only that", async () => {
    const voice = await standIn({ seconds: 0.1 });
    await voice.start();
    try {
      const m = scripted(10_000, true, new SpokenAhead(voice, mkdtempSync(join(tmpdir(), "mouth-"))));
      open(m);
      m.mouth.say("one.");
      await m.mouth.drained();
      const round = m.measures.recent().find((e) => e.kind === "answered") as unknown as Record<string, unknown>;
      expect(round.workerMs).toBe(100);
      expect(Object.keys(round).filter((key) => ["speechTokens", "t3Ms", "s3genMs", "watermarkMs"].includes(key))).toEqual([]);
    } finally { voice.stop(); }
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

describe("the audio off (11.12)", () => {
  test("nothing is made or played, the words still go, and they still count", async () => {
    const m = scripted();
    m.mouth.setAudio(false);
    m.mouth.say("the answer.");
    await tick();
    expect(m.played).toEqual(["the answer."]);
    expect(m.wavs).toEqual([null]);
    expect(m.started).toEqual([]);
    expect(m.mouth.said).toEqual(["the answer."]);
  });

  test("a cue is not played either", () => {
    const m = scripted();
    m.mouth.setAudio(false);
    m.mouth.cue("heard");
    expect(m.cues).toEqual([]);
  });

  test("the sentence in flight is cut at once, and it counts as said", async () => {
    const m = scripted();
    m.blockPlay(true);
    m.mouth.say("a long sentence."); m.mouth.say("the next one.");
    await tick();
    expect(m.cuts[0]?.()).toBe(false);
    m.mouth.setAudio(false);
    expect(m.cuts[0]?.()).toBe(true);
    m.blockPlay(false);
    m.release();
    await tick();
    expect(m.played).toEqual(["a long sentence.", "the next one."]);
    expect(m.wavs[1]).toBeNull();
    expect(m.mouth.said).toEqual(["a long sentence.", "the next one."]);
    expect(m.mouth.busy).toBe(false);
  });

  test("a cue in flight is cut too, and the audio back on plays again", async () => {
    const m = scripted();
    m.mouth.cue("heard");
    expect(m.cuts[0]?.()).toBe(false);
    m.mouth.setAudio(false);
    expect(m.cuts[0]?.()).toBe(true);
    m.mouth.setAudio(true);
    m.mouth.say("back.");
    await tick();
    expect(m.wavs).toEqual(["back..wav"]);
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

describe("a path reaches the voice in a speakable form (5.7.1)", () => {
  test("the engine is given the spoken form, and the screen and the record keep the written one", async () => {
    const m = scripted();
    m.mouth.say("The file is src/sentences.ts.");
    m.mouth.say("Then src/mouth.ts.");
    await tick();
    expect(m.wavs).toEqual(["The file is S R C slash sentences dot T S..wav", "Then S R C slash mouth dot T S..wav"]);
    expect(m.started).toEqual(["Then S R C slash mouth dot T S.", undefined]);
    expect(m.played).toEqual(["The file is src/sentences.ts.", "Then src/mouth.ts."]);
    expect(m.mouth.said).toEqual(["The file is src/sentences.ts.", "Then src/mouth.ts."]);
  });
});

/**
 * 11.6.5 a mouth with openers. `clips` are the lines with a kept clip; a
 * kept clip is taken at once, any other sentence after `takeMs`. An opener
 * plays for `openerMs`, and a sentence at once. `log` has each take, and the
 * start and the end of each sound, with the time since the mouth was made.
 */
function opening(options: { openers?: string[]; clips?: string[]; takeMs?: number; openerMs?: number; muted?: () => boolean; random?: () => number } = {}) {
  const openers = options.openers ?? ["Okay.", "Right.", "Sure."];
  const clips = new Set(options.clips ?? openers);
  const log: Array<{ what: string; at: number }> = [];
  const played: string[] = [];
  const taken: string[] = [];
  const t0 = Date.now();
  const note = (what: string) => log.push({ what, at: Date.now() - t0 });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  let cutting = false;
  const speaker: Speaker = {
    async play(text, wav, cut) {
      played.push(text);
      note(`start ${text}`);
      if (clips.has(text) && openers.includes(text) && options.openerMs) await sleep(options.openerMs);
      note(`end ${text}`);
      return wav === null || !(cutting || cut());
    },
    cue() {},
    track: () => null,
  };
  const made = {
    take: async (text: string) => {
      taken.push(text);
      note(`take ${text}`);
      if (clips.has(text)) return `kept/${text}`;
      if (options.takeMs) await sleep(options.takeMs);
      return `${text}.wav`;
    },
    start: () => {},
    use: () => true,
    times: () => undefined,
    keptClip: (text: string) => clips.has(text) ? `kept/${text}` : null,
  };
  const measures = new Measures();
  const mouth = new Mouth(speaker, made, { file: (name) => `${name}.wav` }, measures, {
    holdBackstopMs: 10_000, voiceChoices: { female: "f", male: "m" }, openers, muted: options.muted, random: options.random,
  });
  /** one answer to Chris: a new turn, and its sentences */
  const answer = async (...sentences: string[]) => {
    mouth.newTurn();
    for (const sentence of sentences) mouth.say(sentence, 1);
    await mouth.drained();
  };
  const at = (what: string) => log.find((entry) => entry.what === what)?.at ?? NaN;
  return { mouth, measures, played, taken, log, answer, at, cut: (on: boolean) => { cutting = on; } };
}

describe("the opener (11.6.5)", () => {
  test("the answer to Chris opens with a kept opener, and the answer follows it", async () => {
    const m = opening({ random: () => 0 });
    await m.answer("The tests pass.", "All of them.");
    expect(m.played).toEqual(["Okay.", "The tests pass.", "All of them."]);
  });

  test("the choice never plays the same opener twice in a row", async () => {
    // a random of 0 takes the first opener it may, every time
    const m = opening({ random: () => 0 });
    for (let turn = 0; turn < 6; turn++) await m.answer(`Answer ${turn}.`);
    const openers = m.played.filter((text) => !text.startsWith("Answer"));
    expect(openers).toHaveLength(6);
    for (let i = 1; i < openers.length; i++) expect(openers[i]).not.toBe(openers[i - 1]);
  });

  test("the choice is random among the openers that may play", async () => {
    const m = opening({ random: () => 0.99 });
    await m.answer("One.");
    expect(m.played[0]).toBe("Sure.");
  });

  test("the only opener with a clip, played last time, is not played again: none is", async () => {
    const m = opening({ openers: ["Okay.", "Right."], clips: ["Right."], random: () => 0 });
    await m.answer("One.");
    await m.answer("Two.");
    await m.answer("Three.");
    expect(m.played).toEqual(["Right.", "One.", "Two.", "Right.", "Three."]);
  });

  test("an opener with no kept clip is never synthesized", async () => {
    const m = opening({ openers: ["Okay.", "Right."], clips: [] });
    await m.answer("One.");
    expect(m.taken).toEqual(["One."]);
    expect(m.played).toEqual(["One."]);
  });

  test("an empty list turns the openers off", async () => {
    const m = opening({ openers: [] });
    await m.answer("One.");
    expect(m.played).toEqual(["One."]);
  });

  test("the first sentence is made before the opener plays, and follows it with no added delay", async () => {
    const m = opening({ takeMs: 80, openerMs: 20, random: () => 0 });
    await m.answer("A sentence the engine makes.");
    expect(m.at("take A sentence the engine makes.")).toBeLessThanOrEqual(m.at("start Okay."));
    // the sentence plays when it is made, not when it is made plus the opener
    expect(m.at("start A sentence the engine makes.")).toBeLessThan(80 + 15);
  });

  test("a sentence made before the opener ends plays right after the opener", async () => {
    const m = opening({ takeMs: 5, openerMs: 60, random: () => 0 });
    await m.answer("A sentence the engine makes.");
    const end = m.at("end Okay.");
    const start = m.at("start A sentence the engine makes.");
    expect(start).toBeGreaterThanOrEqual(end);
    expect(start - end).toBeLessThan(15);
  });

  test("a first sentence that is itself a kept clip gets no opener", async () => {
    const m = opening({ clips: ["Okay.", "Right.", "Sure.", "Nothing is running."] });
    await m.answer("Nothing is running.");
    expect(m.played).toEqual(["Nothing is running."]);
  });

  test("a fixed reply, and an answer nobody asked for, get no opener", async () => {
    const m = opening();
    m.mouth.newTurn();
    m.mouth.reply("Carrying on.");
    m.mouth.reply("The job finished.", 7);
    await m.mouth.drained();
    expect(m.played).toEqual(["Carrying on.", "The job finished."]);
  });

  test("no opener with the audio off", async () => {
    const m = opening();
    m.mouth.setAudio(false);
    await m.answer("One.");
    expect(m.played).toEqual(["One."]);
  });

  test("no opener while muted", async () => {
    const m = opening({ muted: () => true });
    await m.answer("One.");
    expect(m.played).toEqual(["One."]);
  });

  test("a first sentence a barge-in cut gets no second opener when it resumes", async () => {
    const m = opening({ openerMs: 30, random: () => 0 });
    m.mouth.newTurn();
    m.mouth.say("One.", 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    // Chris talks over the opener: it and the sentence behind it are cut
    m.cut(true);
    m.mouth.hold();
    await new Promise((resolve) => setTimeout(resolve, 40));
    m.cut(false);
    m.mouth.resume();
    await m.mouth.drained();
    expect(m.played).toEqual(["Okay.", "One.", "One."]);
  });

  test("the answered line of the record says which opener played, or none", async () => {
    const m = opening({ random: () => 0 });
    const open = () => { const now = Date.now(); m.measures.speechEnded(now - 1_500, now); m.measures.transcribed(now); m.measures.firstDelta(now); };
    open();
    await m.answer("One.");
    open();
    m.mouth.newTurn();
    m.mouth.reply("Carrying on.");
    await m.mouth.drained();
    const rounds = m.measures.recent().filter((e) => e.kind === "answered");
    expect(rounds.map((round) => (round as { opener?: string | null }).opener)).toEqual(["Okay.", null]);
  });

  test("the opener counts as sound: the mouth says when the last one ended", async () => {
    const m = opening({ openerMs: 20, random: () => 0 });
    expect(m.mouth.openerEndedAt).toBe(0);
    const before = Date.now();
    await m.answer("One.");
    expect(m.mouth.openerEndedAt).toBeGreaterThanOrEqual(before + 20);
  });
});
