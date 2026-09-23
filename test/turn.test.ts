import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav } from "../src/audio.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import type { Outgoing } from "../src/messages.ts";
import type { SessionHooks } from "../src/session.ts";
import { Working } from "../src/working.ts";
import { bridge, type Music, type Script } from "./harness.ts";

const config: Partial<Config> = { audioCueDelayMs: 10, audioCueEveryMs: 10 };

/** A room: the bridge as the car assembles it, over fake engines. */
function room(script: Script = {}, overrides: Partial<Config> = {}, music?: Music) {
  return bridge({ script, overrides: { ...config, ...overrides }, music });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the working sign follows the turn, not the sound (14.10)", () => {
  test("with the audio cut, a turn that runs is still work, and its end clears the sign", async () => {
    let end = () => {};
    const r = room({ hold: new Promise<void>((resolve) => { end = resolve; }) });
    r.mouth.setAudio(false);
    const said: boolean[] = [];
    const sign = new Working(() => r.c.busy, () => 0, (on) => said.push(on));
    sign.tick(0);
    expect(said).toEqual([]);
    const turn = r.c.turn("something slow");
    sign.tick(1_000);
    expect(r.mouth.audioOn).toBe(false);
    expect(said).toEqual([true]);
    end();
    await turn;
    sign.tick(2_000);
    expect(said).toEqual([true, false]);
  });
});

describe("a whole turn (5.5, 5.6)", () => {
  test("the answer is spoken as it arrives, sentence by sentence", async () => {
    const r = room({ deltas: ["Two plus two ", "is four. ", "It always ", "was."] });
    await r.c.turn("what is two plus two");
    expect(r.said).toEqual(["Two plus two is four.", "It always was."]);
    expect(r.agent.calls).toContain("ask what is two plus two");
  });

  test("what the turn is remembered as is what was actually said", async () => {
    const r = room({ deltas: ["Four."], text: "the whole answer, unspoken" });
    await r.c.turn("what is two plus two");
    expect(r.turns).toHaveLength(1);
    expect(r.channel.missed().at(-1)).toMatchObject({ kind: "turn", number: 1, text: "Four." });
  });

  test("each sentence and the turn that closes it name their answer (14.7)", async () => {
    const r = room({ deltas: ["Four. ", "It always was."] });
    await r.c.turn("what is two plus two");
    await r.c.turn("and three plus three");
    const named = r.told.filter((m) => m.kind === "sentence" || m.kind === "turn").map((m) => [m.kind, "answer" in m ? m.answer : undefined]);
    expect(named).toEqual([["sentence", 1], ["sentence", 1], ["turn", 1], ["sentence", 2], ["sentence", 2], ["turn", 2]]);
  });

  test("the marker is taken off the front and never reaches the voice, the app or the transcript (15.7.4)", async () => {
    const r = room({ deltas: ["[long] ", "Checking the logs. ", "It is fine."] });
    await r.c.turn("is it fine");
    expect(r.said).toEqual(["Checking the logs.", "It is fine."]);
    const seen = r.told.filter((m) => m.kind === "delta" || m.kind === "sentence" || m.kind === "turn").map((m) => "text" in m ? m.text : "");
    expect(seen.join(" ")).not.toContain("[long]");
    expect(r.told.filter((m) => m.kind === "delta").map((m) => "text" in m ? m.text : "").join("")).toBe("Checking the logs. It is fine.");
    expect(r.channel.missed().at(-1)).toMatchObject({ kind: "turn", text: "Checking the logs. It is fine." });
    expect(r.turns[0]?.text).toBe("Checking the logs. It is fine.");
  });

  test("a marker split across deltas is taken off too (15.7.4)", async () => {
    const r = room({ deltas: ["[", "lo", "ng", "]", " Checking the logs. ", "It is fine."] });
    await r.c.turn("is it fine");
    expect(r.said).toEqual(["Checking the logs.", "It is fine."]);
    expect(r.told.filter((m) => m.kind === "delta").map((m) => "text" in m ? m.text : "").join("")).toBe("Checking the logs. It is fine.");
  });

  test("a start that only looks like the marker is spoken whole (15.7.4)", async () => {
    const r = room({ deltas: ["[lo", "gged in] is the state. ", "Done."] });
    await r.c.turn("what state");
    expect(r.said).toEqual(["[logged in] is the state.", "Done."]);
  });

  test("a reply that ends inside the start of the marker is not lost (15.7.4)", async () => {
    const r = room({ deltas: ["[lo"] });
    await r.c.turn("say it");
    expect(r.said).toEqual(["[lo"]);
  });

  test("a marker in the middle of a reply is left in the text (15.7.4)", async () => {
    const r = room({ deltas: ["Checking. ", "[long] It is fine."] });
    await r.c.turn("is it fine");
    expect(r.said).toEqual(["Checking.", "[long] It is fine."]);
  });

  test("a reply that is only the marker says nothing", async () => {
    const r = room({ deltas: ["[long]"] });
    await r.c.turn("is it fine");
    expect(r.said).toEqual([]);
    expect(r.channel.missed().at(-1)).toMatchObject({ kind: "turn", text: "" });
  });

  test("the marker is not looked for after a tool call (15.7.5)", async () => {
    const r = room({ during: (hooks) => { hooks.onBlockStart?.("tool_use"); hooks.onBlockStart?.("text"); }, deltas: ["[long] It is fine."] });
    await r.c.turn("is it fine");
    expect(r.said).toEqual(["[long] It is fine."]);
  });

  test("a turn that does not finish says so, and does not end the conversation", async () => {
    const r = room({ fail: "the agent died" });
    await r.c.turn("what is two plus two");
    expect(r.said).toEqual(["That turn did not finish."]);
    expect(r.c.busy).toBe(false);
  });

  test("a long wait is not silence (15.1, 15.5)", async () => {
    let answer = () => {};
    const r = room({ deltas: ["Done."], hold: new Promise<void>((resolve) => { answer = resolve; }) });
    const turn = r.c.turn("something slow");
    await new Promise((resolve) => setTimeout(resolve, 45));
    expect(r.cues).toContain("thinking");
    answer();
    await turn;
  });

  test("a turn that answers at once is never cued", async () => {
    const r = room({ deltas: ["Four."] });
    await r.c.turn("what is two plus two");
    expect(r.cues).not.toContain("thinking");
  });
});

describe("the answer reaches the client a sentence at a time (14.7)", () => {
  test("each sentence is told as it is known, and the turn carries the whole", async () => {
    const r = room({ deltas: ["Two plus two ", "is four. ", "It always ", "was."] });
    await r.c.turn("what is two plus two");
    const sentences = r.told.flatMap((value) => (value.kind === "sentence" ? [value.text] : []));
    expect(sentences).toEqual(["Two plus two is four.", "It always was."]);
    expect(r.told.find((value) => value.kind === "turn")).toMatchObject({ text: "Two plus two is four. It always was." });
  });
});

describe("the answer reaches the client a block at a time (14.9)", () => {
  /** What a client is told of one answer, in order, with the words abbreviated to their text. */
  const told = (r: ReturnType<typeof room>) => r.told.flatMap((m) => {
    if (m.kind === "blockStart" || m.kind === "blockEnd") return [`${m.kind} ${m.answer}.${m.block}`];
    if (m.kind === "delta") return [`delta ${m.answer}.${m.block} ${m.text}`];
    if (m.kind === "sentence") return [`sentence ${m.answer} ${m.text}`];
    if (m.kind === "turn") return [`turn ${m.answer}`];
    return [];
  });

  test("a tool call splits the answer, and each block's words come before the sentence they finish", async () => {
    let hooks: SessionHooks = {};
    const r = room({
      during: (given) => { hooks = given; },
      hold: Promise.resolve(),
    });
    // the scripted agent gives its hooks to `during` before it answers, so drive the blocks from there
    const turn = r.c.turn("look and tell me");
    hooks.onBlockStart?.("thinking");
    hooks.onBlockEnd?.();
    hooks.onBlockStart?.("text");
    hooks.onDelta?.("Let me look. ");
    hooks.onBlockEnd?.();
    hooks.onBlockStart?.("tool_use");
    hooks.onBlockEnd?.();
    hooks.onBlockStart?.("text");
    hooks.onDelta?.("Found it.");
    hooks.onBlockEnd?.();
    await turn;
    expect(told(r)).toEqual([
      "blockStart 1.1",
      "delta 1.1 Let me look. ",
      "sentence 1 Let me look.",
      "blockEnd 1.1",
      "blockStart 1.2",
      "delta 1.2 Found it.",
      "blockEnd 1.2",
      "sentence 1 Found it.",
      "turn 1",
    ]);
  });

  test("the next answer counts its blocks from 1 again", async () => {
    let hooks: SessionHooks = {};
    const r = room({ during: (given) => { hooks = given; }, hold: Promise.resolve() });
    for (const said of ["one", "two"]) {
      const turn = r.c.turn(said);
      hooks.onBlockStart?.("text");
      hooks.onDelta?.("Yes.");
      hooks.onBlockEnd?.();
      await turn;
    }
    expect(told(r).filter((line) => line.startsWith("blockStart"))).toEqual(["blockStart 1.1", "blockStart 2.1"]);
  });

  test("a block that arrives after the turn is over opens an answer of its own (11.11)", async () => {
    const r = room({ deltas: ["Done."] });
    await r.c.turn("quick");
    const before = told(r).length;
    r.agent.hooks().onBlockStart?.("text");
    r.agent.hooks().onDelta?.("Late news.");
    r.agent.hooks().onBlockEnd?.();
    r.agent.hooks().onUnprompted?.({ number: 2, text: "Late news.", costUsd: 0.01, isError: false });
    expect(told(r).slice(before)).toEqual([
      "blockStart 2.1",
      "delta 2.1 Late news.",
      "blockEnd 2.1",
      "sentence 2 Late news.",
      "turn 2",
    ]);
  });
});

describe("the round trip's marks (18.4)", () => {
  test("the agent's first word is marked, once, on the round the utterance opened", async () => {
    const r = room({ deltas: ["Two plus two ", "is four. ", "It always ", "was."] });
    const now = Date.now();
    r.c.measures.speechEnded(now - 1_500, now);
    r.c.measures.transcribed(now);
    await r.c.turn("what is two plus two");
    const rounds = r.c.measures.recent().filter((e) => e.kind === "answered") as Array<{ agentMs: number; sentenceMs: number }>;
    expect(rounds).toHaveLength(1);
    expect(rounds[0]?.agentMs).toBeGreaterThanOrEqual(0);
    expect(rounds[0]?.sentenceMs).toBeGreaterThanOrEqual(0);
  });
});

describe("the rate-limit warning (13.2)", () => {
  test("it speaks the number claude reports, once the turn is done", async () => {
    const r = room({ deltas: ["Done."], rateLimit: { fiveHour: 0.92, sevenDay: 0.1 } }, { usageWarnFraction: 0.8 });
    await r.c.turn("do something");
    expect(r.said.at(-1)).toBe("A heads up: rate limit use is at 92 percent.");
  });

  test("under the threshold it says nothing about usage", async () => {
    const r = room({ deltas: ["Done."], rateLimit: { fiveHour: 0.3, sevenDay: 0.1 } }, { usageWarnFraction: 0.8 });
    await r.c.turn("do something");
    expect(r.said).toEqual(["Done."]);
  });
});

describe("the checkpoint (8.6.3)", () => {
  test("the bridge asks, and the agreement word lets the turn run on", async () => {
    let answer = () => {};
    const r = room({
      deltas: ["Done."],
      during: (hooks) => hooks.onCheckpoint?.(600_000),
      hold: new Promise<void>((resolve) => { answer = resolve; }),
    });
    const turn = r.c.turn("something long");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(r.said[0]).toContain("This turn has run 10 minutes");
    expect(r.said[0]).toContain("Say continue");
    expect(r.c.waitingForAgreement).toBe(true);
    await r.c.heard("continue");
    expect(r.agent.calls).toContain("agree");
    answer();
    await turn;
  });
});

describe("clearing the context is gated (10.1, ADR 0009)", () => {
  test("it reads back what it is about to do, and waits", async () => {
    const r = room();
    await r.c.heard("sidetone clear the context");
    expect(r.said.at(-1)).toContain("I am about to clear the context");
    expect(r.agent.calls).not.toContain("restart cleared by voice");
  });

  test("the agreement word clears it", async () => {
    const r = room();
    await r.c.heard("sidetone clear the context");
    await r.c.heard("continue");
    expect(r.agent.calls).toContain("restart cleared by voice");
  });

  test("anything else does not, and says so (10.5)", async () => {
    const r = room();
    await r.c.heard("sidetone clear the context");
    await r.c.heard("yes go on");
    await tick();
    expect(r.agent.calls).not.toContain("restart cleared by voice");
    expect(r.said.at(-1)).toContain("Nothing was cleared.");
  });
});

describe("11.9 a question that lands mid-answer", () => {
  /** A turn in flight, with one sentence heard and two held behind a barge-in. */
  async function midAnswer(overrides: Partial<Config> = {}) {
    let answer = () => {};
    const hold = new Promise<void>((resolve) => { answer = resolve; });
    // a turn that ends only when it is made to, so the wait of 11.9 runs out
    const r = room({ hold, onInterrupt: () => answer(), text: "One. Two. Three." },
      { interruptAfterMs: 20, ...overrides });
    const turn = r.c.turn("how does a suspension bridge work");
    await tick();
    r.agent.hooks().onDelta?.("One. ");
    await tick();
    r.c.ears.stopSpeaking();
    r.agent.hooks().onDelta?.("Two. Three. ");
    await tick();
    return { ...r, turn, answer };
  }

  test("holding: it is refused and the answer resumes", async () => {
    const r = await midAnswer({ interruptOnSpeech: false });
    await r.c.heard("what is the tallest one");
    await tick();
    expect(r.said.join(" ")).toContain("I am still on the last one");
    expect(r.agent.calls).not.toContain("interrupt");
    expect(r.said).toContain("Two.");
    r.answer();
    await r.turn;
  });

  test("interrupting: the answer stops, the question is asked, nothing else is said", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("what is the tallest one");
    expect(r.agent.calls).toContain("interrupt");
    expect(r.said.join(" ")).not.toContain("I am still on the last one");
    expect(r.said).not.toContain("Two.");
    expect(r.said).not.toContain("Three.");
  });

  test("interrupting: the record says the bridge waited, then interrupted", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("what is the tallest one");
    const cutoffs = r.c.measures.recent().filter((e) => e.kind === "cutoff");
    expect(cutoffs).toMatchObject([{ kind: "cutoff", interrupted: true }]);
    expect((cutoffs[0] as { waitedMs: number }).waitedMs).toBeGreaterThanOrEqual(15);
  });

  test("interrupting: a turn that ends inside the wait is recorded as not interrupted", async () => {
    const r = await midAnswer({ interruptOnSpeech: true, interruptAfterMs: 500 });
    const heard = r.c.heard("what is the tallest one");
    r.answer();
    await heard;
    expect(r.agent.calls).not.toContain("interrupt");
    expect(r.c.measures.recent().filter((e) => e.kind === "cutoff")).toMatchObject([{ kind: "cutoff", interrupted: false }]);
  });

  test("interrupting: the agent is told where Chris stopped hearing, and the question is clean", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("what is the tallest one");
    const asked = r.agent.calls.filter((call) => call.startsWith("ask ")).at(-1) ?? "";
    expect(asked).toContain('The voice stopped mid-answer, after: "One."');
    // 18 September: told only that he missed the rest, the agent said it again
    expect(asked).toContain("Do not repeat any of it");
    expect(asked).toContain("what is the tallest one");
    // the note is for the agent; the transcript keeps what Chris actually said
    expect(r.channel.missed().some((entry) => entry.text === "what is the tallest one")).toBe(true);
  });

  test("interrupting: what was not spoken is already on the client as text, and gets no note (11.10)", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("what is the tallest one");
    expect(r.told.some((value) => value.kind === "narration" && value.text.startsWith("not spoken:"))).toBe(false);
    const shown = r.told.flatMap((value) => (value.kind === "sentence" || value.kind === "delta" ? [value.text] : [])).join(" ");
    expect(shown).toContain("Two.");
    expect(shown).toContain("Three.");
  });

  test("carry on says the rest, once, without asking the agent again", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("what is the tallest one");
    const asks = r.agent.calls.filter((call) => call.startsWith("ask ")).length;
    await r.c.heard("sidetone carry on");
    await tick();
    expect(r.said).toContain("Two.");
    expect(r.said).toContain("Three.");
    expect(r.agent.calls.filter((call) => call.startsWith("ask ")).length).toBe(asks);
    await r.c.heard("sidetone carry on");
    expect(r.said.join(" ")).toContain("There is nothing left of it");
  });

  test("the mode is a wake command, and it says which way it now is", async () => {
    const r = room({}, { interruptOnSpeech: false });
    await r.c.heard("sidetone interrupt on");
    await tick();
    expect(r.said).toContain("Interrupting on.");
    await r.c.heard("sidetone interrupt off");
    await tick();
    expect(r.said).toContain("Interrupting off.");
    await r.c.heard("sidetone interrupt");
    await tick();
    expect(r.said.at(-1)).toBe("Interrupting on.");
  });
});

describe("11.9 waiting before insisting", () => {
  /** A turn that ends on its own a moment after the question lands. */
  async function endsByItself(afterMs: number, patienceMs: number) {
    let answer = () => {};
    const hold = new Promise<void>((resolve) => { answer = resolve; });
    // the real process returns a result once it takes an interrupt, so the
    // stub does too: without that this measures the grace timer, not the wait
    const r = room({ hold, text: "One. Two.", onInterrupt: () => answer() },
      { interruptOnSpeech: true, interruptAfterMs: patienceMs });
    const turn = r.c.turn("something");
    await tick();
    r.agent.hooks().onDelta?.("One. ");
    await tick();
    r.c.ears.stopSpeaking();
    setTimeout(answer, afterMs);
    await r.c.heard("what is the tallest one");
    await turn;
    return r;
  }

  test("a turn that ends by itself is never interrupted, so a subagent lives", async () => {
    const r = await endsByItself(10, 200);
    expect(r.agent.calls).not.toContain("interrupt");
    // and the question still gets asked, with the note in front of it
    expect(r.agent.calls.filter((call) => call.startsWith("ask ")).length).toBe(2);
  });

  test("a turn that will not end is interrupted after the wait", async () => {
    const r = await endsByItself(10_000, 20);
    expect(r.agent.calls).toContain("interrupt");
  });

  test("the wait is silent: nothing of the stopped answer is said", async () => {
    const r = await endsByItself(10, 200);
    expect(r.said).not.toContain("Two.");
  });
});

describe("11.11 a turn nobody asked for", () => {
  const turnOf = (text: string, isError = false) => ({ number: 7, text, costUsd: 0.01, isError });
  /** The agent speaks unasked: the stream of one text block, then the result. */
  const unasked = (r: ReturnType<typeof room>, text: string) => {
    const hooks = r.agent.hooks();
    hooks.onBlockStart?.("text");
    hooks.onDelta?.(text);
    hooks.onBlockEnd?.();
    hooks.onUnprompted?.(turnOf(text));
  };

  test("it is spoken, sentence by sentence, and reaches the client", async () => {
    const r = room();
    unasked(r, "The search finished. It found nine files.");
    await tick();
    expect(r.said).toEqual(["The search finished.", "It found nine files."]);
    expect(r.told.some((value) => value.kind === "turn" && String(value.text).startsWith("The search finished"))).toBe(true);
  });

  test("it streams as a turn Chris asked for does, under an answer of its own", async () => {
    const r = room();
    const hooks = r.agent.hooks();
    hooks.onBlockStart?.("text");
    hooks.onDelta?.("The build ");
    hooks.onDelta?.("is green.");
    hooks.onBlockEnd?.();
    hooks.onUnprompted?.(turnOf("The build is green."));
    await r.mouth.drained();
    const streamed = r.told.flatMap((m) => ("answer" in m && m.kind !== "speaking" ? [[m.kind, m.answer]] : []));
    expect(streamed).toEqual([["blockStart", 1], ["delta", 1], ["delta", 1], ["blockEnd", 1], ["sentence", 1], ["turn", 1]]);
    expect(r.told.find((m) => m.kind === "turn")).toMatchObject({ number: 7, text: "The build is green.", answer: 1 });
    // 14.13 the voice names the answer too, so the client can light its words
    expect(r.told.filter((m) => m.kind === "speaking")).toEqual([{ kind: "speaking", text: "The build is green.", answer: 1 }]);
  });

  test("the next turn Chris asks for is a new answer", async () => {
    const r = room({ deltas: ["Yes."] });
    unasked(r, "The build is green.");
    await r.c.turn("is it deployed");
    const turns = r.told.flatMap((m) => (m.kind === "turn" ? [m.answer] : []));
    expect(turns).toEqual([1, 2]);
  });

  test("it jumps a hold, because news is not the answer it landed on", async () => {
    const r = room();
    r.c.ears.stopSpeaking();
    unasked(r, "The build is green.");
    await tick();
    expect(r.said).toContain("The build is green.");
  });

  test("talked over, it is said once and waits, rather than spinning", async () => {
    // the drive of 18 September: one refusal, eighteen times in three seconds
    const r = room();
    r.c.ears.stopSpeaking();
    unasked(r, "The build is green.");
    await tick();
    await tick();
    expect(r.said.filter((line) => line === "The build is green.").length).toBe(1);
  });

  test("one with no words says nothing and tells nothing", async () => {
    const r = room();
    r.agent.hooks().onUnprompted?.(turnOf("   "));
    r.agent.hooks().onUnprompted?.(turnOf("It broke.", true));
    await tick();
    expect(r.said).toEqual([]);
    expect(r.told.filter((m) => m.kind === "turn")).toEqual([]);
  });
});

/**
 * The commands that answer from the bridge itself, driven through a real turn
 * rather than by setting the conversation's fields. conversation.test.ts used
 * to reach in for `turnRunning` and `lastReply`; the scripted agent gets there
 * by the front door.
 */
describe("what the bridge answers from itself (9.4.5, 9.4.6, 9.4.7)", () => {
  async function midAnswer() {
    let answer = () => {};
    const hold = new Promise<void>((resolve) => { answer = resolve; });
    const r = room({ hold, text: "One. Two. Three." }, { interruptOnSpeech: false });
    const turn = r.c.turn("how does a suspension bridge work");
    await tick();
    r.agent.hooks().onDelta?.("One. ");
    await tick();
    r.c.ears.stopSpeaking();
    r.agent.hooks().onDelta?.("Two. Three. ");
    await tick();
    return { ...r, turn, answer };
  }

  test("restate mid-answer says the last sentence heard, and the rest resumes", async () => {
    const r = await midAnswer();
    await r.c.heard("sidetone say that again");
    await tick();
    expect(r.said.slice(0, 2)).toEqual(["One.", "One."]);
    expect(r.said).toContain("Two.");
    r.answer();
    await r.turn;
  });

  test("summarize mid-answer is refused, and the turn goes on", async () => {
    const r = await midAnswer();
    await r.c.heard("sidetone summarize");
    await tick();
    expect(r.said[1]).toBe("I am still on the last one. Say sidetone, end the turn, to stop it.");
    expect(r.said).toContain("Two.");
    expect(r.agent.calls.filter((call) => call.startsWith("ask"))).toHaveLength(1);
    r.answer();
    await r.turn;
  });

  test("between turns restate means the whole last answer", async () => {
    const r = room({ deltas: ["the answer before this one."] });
    await r.c.turn("first");
    await r.c.heard("sidetone say that again");
    await tick();
    expect(r.said).toEqual(["the answer before this one.", "the answer before this one."]);
  });

  test("where are we reads back what was asked, and drops a held passage", async () => {
    const r = room({ deltas: ["it joins the room."] });
    await r.c.turn("what does serve do");
    r.c.ears.stopSpeaking();
    r.mouth.say("the rest.");
    await r.c.heard("sidetone where are we");
    await tick();
    expect(r.said.at(-1)).toBe("You asked: what does serve do I said: it joins the room.");
    expect(r.said).not.toContain("the rest.");
  });
});

/**
 * 15.7 hold music. Real timers, as the cue test above: the times are tens of
 * milliseconds, and the margins are wider than the timers' jitter.
 */
describe.skipIf(!Bun.which("ffmpeg"))("hold music (15.7 to 15.11)", () => {
  const file = join(mkdtempSync(join(tmpdir(), "hold-")), "hold.wav");
  Bun.write(file, encodeWav(new Int16Array(4_800).fill(1_000), 48_000));
  const AFTER = 100;
  /** 15.7.4 the marker alone, so the turn is long and no sentence has moved the silence */
  const LONG = ["[long]"];
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** a track that is due is waited for, so a slow machine does not fail a test that is right */
  async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !done(); i++) await wait(10);
  }
  /**
   * A turn that runs until `end()`, in a room whose track lasts until it is cut.
   * The file is decoded before the turn starts, so the times below are the
   * bridge's and not ffmpeg's.
   */
  async function slow(overrides: Partial<Config> = {}, more: Partial<Music> = {}, opening: string[] = LONG) {
    let end = () => {};
    const r = room({ during: (hooks) => { for (const delta of opening) hooks.onDelta?.(delta); }, hold: new Promise<void>((resolve) => { end = resolve; }) }, { holdMusicAfterMs: AFTER, ...overrides }, { file, ...more });
    await r.mouth.music(() => true);
    return { ...r, end, turn: r.c.turn("something slow") };
  }

  test("the silence is measured from the hand-over to the agent", async () => {
    const r = await slow();
    await wait(AFTER * 0.5);
    expect(r.tracks).toHaveLength(0);
    await until(() => r.tracks.length > 0);
    expect(r.tracks).toHaveLength(1);
    r.end();
    await r.turn;
  });

  test("a sentence moves the start of the silence to its end", async () => {
    const r = await slow();
    await wait(AFTER * 0.6);
    r.agent.hooks().onDelta?.("Still on it. ");
    // past the hand-over plus the wait, but not the end of the sentence plus the wait
    await wait(AFTER * 0.8);
    expect(r.said).toEqual(["Still on it."]);
    expect(r.tracks).toHaveLength(0);
    await until(() => r.tracks.length > 0);
    expect(r.tracks).toHaveLength(1);
    r.end();
    await r.turn;
  });

  test("a setting of zero turns it off", async () => {
    const r = await slow({ holdMusicAfterMs: 0 });
    await wait(AFTER * 2);
    expect(r.tracks).toHaveLength(0);
    r.end();
    await r.turn;
  });

  test("switched off, it does not start (15.7.3)", async () => {
    const r = await slow({ holdMusic: false });
    await wait(AFTER * 3);
    expect(r.tracks).toHaveLength(0);
    r.end();
    await r.turn;
  });

  test("\"music off\" in the middle of a turn stops the track and keeps it off (15.7.3)", async () => {
    const r = await slow();
    await until(() => r.tracks.length > 0);
    await r.c.heard("sidetone music off");
    await wait(20);
    expect(r.tracks[0]?.stopped).toBe(true);
    await wait(AFTER * 4);
    expect(r.tracks).toHaveLength(1);
    r.end();
    await r.turn;
  });

  test("the app's music button stops the track as the command does (17.10)", async () => {
    const r = await slow();
    await until(() => r.tracks.length > 0);
    r.c.setMusic(false);
    await wait(20);
    expect(r.tracks[0]?.stopped).toBe(true);
    await wait(AFTER * 4);
    expect(r.tracks).toHaveLength(1);
    r.end();
    await r.turn;
  });

  test("\"music on\" in the middle of a turn starts it again (15.7.3)", async () => {
    const r = await slow({ holdMusic: false });
    await wait(AFTER * 2);
    expect(r.tracks).toHaveLength(0);
    await r.c.heard("sidetone music on");
    await until(() => r.tracks.length > 0);
    expect(r.tracks).toHaveLength(1);
    r.end();
    await r.turn;
  });

  test("it plays once per silent stretch, and a sentence starts a new one", async () => {
    const r = await slow({}, { lasts: 5 });
    await until(() => r.tracks.length > 0);
    await wait(AFTER * 3);
    expect(r.tracks).toHaveLength(1);
    r.agent.hooks().onDelta?.("Nearly there. ");
    await wait(AFTER * 0.5);
    expect(r.tracks).toHaveLength(1);
    await until(() => r.tracks.length > 1);
    expect(r.tracks).toHaveLength(2);
    r.end();
    await r.turn;
  });

  test("Chris talking stops it", async () => {
    const r = await slow();
    await until(() => r.tracks.length > 0);
    expect(r.tracks[0]?.stopped).toBe(false);
    r.talk();
    await wait(20);
    expect(r.tracks[0]?.stopped).toBe(true);
    r.end();
    await r.turn;
  });

  test("it does not start while Chris is talking", async () => {
    const r = await slow();
    r.talk();
    await wait(AFTER * 2);
    expect(r.tracks).toHaveLength(0);
    r.end();
    await r.turn;
  });

  test("a sentence fades it out, and does not cut it (15.10.2)", async () => {
    const r = await slow({ holdMusicFadeMs: 80 }, { sentenceMs: 60 });
    await until(() => r.tracks.length > 0);
    r.agent.hooks().onDelta?.("Done. ");
    await wait(30);
    expect(r.tracks[0]?.stopped).toBe(false);
    await until(() => r.tracks[0]?.stopped === true);
    expect(r.tracks[0]?.stopped).toBe(true);
    r.end();
    await r.turn;
  });

  test("Chris talking cuts it in the middle of a fade", async () => {
    const r = await slow({ holdMusicFadeMs: 5_000 }, { sentenceMs: 60 });
    await until(() => r.tracks.length > 0);
    r.agent.hooks().onDelta?.("Done. ");
    await wait(20);
    expect(r.tracks[0]?.stopped).toBe(false);
    r.talk();
    await wait(20);
    expect(r.tracks[0]?.stopped).toBe(true);
    r.end();
    await r.turn;
  });

  test("the audio off stops it at once, and it does not start again (11.12)", async () => {
    const r = await slow({ holdMusicFadeMs: 5_000 });
    await until(() => r.tracks.length > 0);
    expect(r.tracks[0]?.stopped).toBe(false);
    r.mouth.setAudio(false);
    await wait(20);
    expect(r.tracks[0]?.stopped).toBe(true);
    await wait(AFTER * 4);
    expect(r.tracks).toHaveLength(1);
    r.end();
    await r.turn;
  });

  test("with the audio off it does not start at all (11.12)", async () => {
    const r = await slow();
    r.mouth.setAudio(false);
    await wait(AFTER * 3);
    expect(r.tracks).toHaveLength(0);
    r.mouth.setAudio(true);
    await until(() => r.tracks.length > 0);
    expect(r.tracks).toHaveLength(1);
    r.end();
    await r.turn;
  });

  test("the end of the turn stops it", async () => {
    const r = await slow();
    await until(() => r.tracks.length > 0);
    expect(r.tracks[0]?.stopped).toBe(false);
    r.end();
    await r.turn;
    await wait(20);
    expect(r.tracks[0]?.stopped).toBe(true);
  });

  test("a turn that is no longer the mouth's does not start it", async () => {
    const r = await slow({ interruptOnSpeech: true, interruptAfterMs: 20 });
    // an interrupt that the scripted agent never answers, so the old turn runs on
    void r.c.heard("what is the tallest one");
    await wait(AFTER * 2);
    expect(r.tracks).toHaveLength(0);
    r.end();
    await r.turn;
  });

  test("a muted bridge is left in peace", async () => {
    const r = room({ during: (hooks) => hooks.onDelta?.("[long]"), hold: new Promise<void>(() => {}) }, { holdMusicAfterMs: AFTER }, { file });
    await r.c.heard("sidetone mute");
    void r.c.turn("something slow");
    await wait(AFTER * 3);
    expect(r.tracks).toHaveLength(0);
  });

  test("it is not played while the bridge waits for the agreement word", async () => {
    const r = await slow();
    r.agent.hooks().onCheckpoint?.(600_000);
    await wait(AFTER * 3);
    expect(r.tracks).toHaveLength(0);
    r.end();
    await r.turn;
  });

  test("a gated action waits in silence too", async () => {
    const r = await slow();
    await r.c.heard("sidetone clear the context");
    await wait(AFTER * 3);
    expect(r.tracks).toHaveLength(0);
    r.end();
    await r.turn;
  });

  test("a source that is in use is asked again, and the track plays when it is free", async () => {
    const r = await slow();
    r.source.taken = true;
    await wait(AFTER * 1.5);
    expect(r.tracks).toHaveLength(0);
    r.source.taken = false;
    await until(() => r.tracks.length > 0);
    expect(r.tracks).toHaveLength(1);
    r.end();
    await r.turn;
  });

  test("a file that is missing is said once and never tried again", async () => {
    let end = () => {};
    const r = room({ during: (hooks) => hooks.onDelta?.("[long]"), hold: new Promise<void>((resolve) => { end = resolve; }) }, { holdMusicAfterMs: 20 }, { file: "/nowhere/hold-music.mp3" });
    const turn = r.c.turn("something slow");
    await wait(200);
    expect(r.tracks).toHaveLength(0);
    expect(r.journal.filter((line) => line.startsWith("[no hold music:"))).toHaveLength(1);
    end();
    await turn;
  });

  test("a turn with no marker gets no music (15.7.4)", async () => {
    const r = await slow({}, {}, []);
    await wait(AFTER * 3);
    expect(r.tracks).toHaveLength(0);
    r.end();
    await r.turn;
  });

  test("a turn that starts with a sentence and no marker gets no music (15.7.4)", async () => {
    const r = await slow({}, {}, ["Checking now. "]);
    await wait(AFTER * 3);
    expect(r.said).toEqual(["Checking now."]);
    expect(r.tracks).toHaveLength(0);
    r.end();
    await r.turn;
  });

  test("a marker in the middle of a reply is not one: it stays in the text and no music plays (15.7.4)", async () => {
    const r = await slow({}, {}, ["Checking now. ", "[long] Still on it. "]);
    await wait(AFTER * 3);
    expect(r.said).toEqual(["Checking now.", "[long] Still on it."]);
    expect(r.tracks).toHaveLength(0);
    r.end();
    await r.turn;
  });

  test("a marker split across deltas makes a long turn (15.7.4)", async () => {
    const r = await slow({}, {}, ["[lo", "ng", "]"]);
    await until(() => r.tracks.length > 0);
    expect(r.tracks).toHaveLength(1);
    expect(r.said).toEqual([]);
    r.end();
    await r.turn;
  });

  test("a reply that starts with a tool call is long on its own, whatever it says later (15.7.5)", async () => {
    let end = () => {};
    const r = room({
      during: (hooks) => { hooks.onBlockStart?.("tool_use"); hooks.onBlockEnd?.(); hooks.onBlockStart?.("text"); hooks.onDelta?.("[long] Done. "); },
      hold: new Promise<void>((resolve) => { end = resolve; }),
    }, { holdMusicAfterMs: AFTER }, { file });
    await r.mouth.music(() => true);
    const turn = r.c.turn("something slow");
    await until(() => r.tracks.length > 0);
    expect(r.tracks).toHaveLength(1);
    expect(r.said).toEqual(["[long] Done."]);
    end();
    await turn;
  });

  test("a tool call partway through a reply makes the rest of the turn long (15.7.5)", async () => {
    let end = () => {};
    const r = room({
      during: (hooks) => { hooks.onDelta?.("Checking now. "); hooks.onBlockStart?.("tool_use"); hooks.onBlockEnd?.(); },
      hold: new Promise<void>((resolve) => { end = resolve; }),
    }, { holdMusicAfterMs: AFTER }, { file });
    await r.mouth.music(() => true);
    const turn = r.c.turn("something slow");
    await until(() => r.tracks.length > 0);
    expect(r.tracks).toHaveLength(1);
    expect(r.said).toEqual(["Checking now."]);
    end();
    await turn;
  });

  /**
   * To-do item 31, as the stream sends it on 22 and 23 September: the text
   * block ends at the full stop with no space after it, the tool runs, and the
   * next text block starts with a capital letter and no space before it. The
   * opening sentence waited for the tool and then went out glued to the result.
   */
  test("the sentence before a tool call is said before the music, and alone (item 31)", async () => {
    let end = () => {};
    const r = room({
      during: (hooks) => {
        hooks.onBlockStart?.("text");
        hooks.onDelta?.("I'll check the worktrees.");
        hooks.onBlockEnd?.();
        hooks.onBlockStart?.("tool_use");
        hooks.onBlockEnd?.();
      },
      hold: new Promise<void>((resolve) => { end = resolve; }),
      deltas: ["Yes, there are two."],
    }, { holdMusicAfterMs: AFTER }, { file });
    await r.mouth.music(() => true);
    const turn = r.c.turn("are there open worktrees");
    await until(() => r.tracks.length > 0);
    expect(r.said).toEqual(["I'll check the worktrees."]);
    end();
    await turn;
    expect(r.said).toEqual(["I'll check the worktrees.", "Yes, there are two."]);
  });

  test("a number split across deltas inside one text block is not split (item 31)", async () => {
    const r = room({
      during: (hooks) => {
        hooks.onBlockStart?.("text");
        hooks.onDelta?.("It costs 3.");
        hooks.onDelta?.("5 cents. Then more.");
        hooks.onBlockEnd?.();
      },
    }, { holdMusicAfterMs: AFTER }, { file });
    await r.c.turn("how much");
    expect(r.said).toEqual(["It costs 3.5 cents.", "Then more."]);
  });
});

/**
 * 15.12 a file asked for through `/play`, which the mouth owns like the hold
 * music. Measured live on 22 September: the agent asked for a track, said one
 * sentence about it in the same turn, and its own sentence stopped the track
 * one second in.
 */
describe("the voice reaching a sentence (14.13)", () => {
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !done(); i++) await wait(10);
  }

  test("a client is told as each sentence starts, with the answer it belongs to", async () => {
    const r = room({ deltas: ["One. ", "Two. "] });
    await r.c.turn("say two sentences");
    const spoken = r.told.flatMap((message) => (message.kind === "speaking" ? [message] : []));
    expect(spoken.map((message) => message.text)).toEqual(["One.", "Two."]);
    expect(spoken.every((message) => message.answer === 1)).toBe(true);
    // the words are known before they are heard: the sentence message comes first
    const kinds = r.told.map((message) => message.kind);
    expect(kinds.indexOf("sentence")).toBeLessThan(kinds.indexOf("speaking"));
  });

  test("a reply from the bridge itself is said with no answer behind it", async () => {
    const r = room();
    r.mouth.reply("Muted.");
    await until(() => r.said.length > 0);
    const spoken = r.told.flatMap((message) => (message.kind === "speaking" ? [message] : []));
    expect(spoken).toEqual([{ kind: "speaking", text: "Muted." }]);
  });

  test("a held sentence is not said to be speaking until it plays", async () => {
    const r = room();
    r.c.ears.stopSpeaking();
    r.mouth.say("the rest of the answer.", 3);
    await wait(20);
    // 11.3 the words are known and queued, but the voice has not reached them
    expect(r.told.filter((message) => message.kind === "speaking")).toEqual([]);
    r.mouth.resume();
    await until(() => r.said.length > 0);
    expect(r.told.filter((message) => message.kind === "speaking"))
      .toEqual([{ kind: "speaking", text: "the rest of the answer.", answer: 3 }]);
  });
});

describe("a track asked for (15.12)", () => {
  const wav = new Uint8Array(64);
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 200 && !done(); i++) await wait(10);
  }

  test("it waits for the sentence instead of being cut off by it", async () => {
    const r = room({}, {}, { file: "/nowhere.wav" });
    r.mouth.say("Playing it now.");
    r.blockSay(true);
    r.mouth.play(wav);
    await wait(30);
    // the mouth is speaking, so nothing has taken the source
    expect(r.tracks).toHaveLength(0);
    r.blockSay(false);
    r.release();
    await until(() => r.tracks.length > 0);
    expect(r.tracks).toHaveLength(1);
    expect(r.tracks[0]?.stopped).toBe(false);
  });

  test("a sentence waits for it instead of cutting it", async () => {
    const r = room({}, {}, { file: "/nowhere.wav", lasts: 120 });
    r.mouth.play(wav);
    await until(() => r.tracks.length > 0);
    r.mouth.say("That was Opus number one.");
    await wait(40);
    // the track is still playing, and the sentence has not started over it
    expect(r.said).toEqual([]);
    expect(r.tracks[0]?.stopped).toBe(false);
    await until(() => r.said.length > 0);
    expect(r.said).toEqual(["That was Opus number one."]);
  });

  test("Chris talking cuts it, as it cuts the hold music", async () => {
    const r = room({}, {}, { file: "/nowhere.wav" });
    r.mouth.play(wav);
    await until(() => r.tracks.length > 0);
    r.talk();
    await until(() => r.tracks[0]?.stopped === true);
    expect(r.tracks[0]?.stopped).toBe(true);
  });

  test("with the audio off it plays nothing at all (11.12)", async () => {
    const r = room({}, {}, { file: "/nowhere.wav" });
    r.mouth.setAudio(false);
    r.mouth.play(wav);
    await wait(60);
    expect(r.tracks).toHaveLength(0);
  });

  test("the record says when a track started and when it stopped (15.7)", async () => {
    const r = room({}, {}, { file: "/nowhere.wav" });
    r.mouth.play(wav);
    await until(() => r.tracks.length > 0);
    r.talk();
    await until(() => r.measures.recent().filter((e) => e.kind === "track").length === 2);
    const events = r.measures.recent().flatMap((e) => (e.kind === "track" ? [e] : []));
    expect(events.map((e) => [e.what, e.on])).toEqual([["file", true], ["file", false]]);
    expect(events[1]?.ms).toBeGreaterThanOrEqual(0);
    expect(events[1]?.whole).toBe(false);
  });
});
