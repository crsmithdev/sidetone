import { describe, expect, setSystemTime, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeWav, encodeWav } from "../src/audio.ts";
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
    expect(r.agent.calls.at(-1)).toEndWith("\n\nwhat is two plus two");
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

  test("each delta carries its number in the block, from 1, so the app can put the words in order", async () => {
    let hooks: SessionHooks = {};
    const r = room({ during: (given) => { hooks = given; }, hold: Promise.resolve() });
    const turn = r.c.turn("look and tell me");
    hooks.onBlockStart?.("text");
    hooks.onDelta?.("Let me ");
    hooks.onDelta?.("look. ");
    hooks.onBlockEnd?.();
    hooks.onBlockStart?.("tool_use");
    hooks.onBlockEnd?.();
    hooks.onBlockStart?.("text");
    hooks.onDelta?.("Found it.");
    hooks.onBlockEnd?.();
    await turn;
    const deltas = r.told.flatMap((m) => (m.kind === "delta" ? [`${m.block}.${m.seq} ${m.text}`] : []));
    expect(deltas).toEqual(["1.1 Let me ", "1.2 look. ", "2.1 Found it."]);
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

  test("two turns over the threshold give one warning", async () => {
    const r = room({ deltas: ["Done."], rateLimit: { fiveHour: 0.92, sevenDay: 0.1 } }, { usageWarnFraction: 0.8 });
    await r.c.turn("do something");
    await r.c.turn("do something else");
    expect(r.said.filter((line) => line.startsWith("A heads up"))).toHaveLength(1);
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
  /**
   * A turn in flight, with one sentence heard and two held behind a barge-in.
   * `answer` ends it, as the result of the process does.
   */
  async function midAnswer(overrides: Partial<Config> = {}, script: Script = {}) {
    let answer = () => {};
    const hold = new Promise<void>((resolve) => { answer = resolve; });
    const r = room({ hold, text: "One. Two. Three.", ...script }, overrides);
    const turn = r.c.turn("how does a suspension bridge work");
    await tick();
    r.agent.hooks().onDelta?.("One. ");
    await tick();
    r.c.ears.stopSpeaking();
    r.agent.hooks().onDelta?.("Two. Three. ");
    await tick();
    return { ...r, turn, answer };
  }
  const injected = (r: { agent: { calls: string[] } }) => r.agent.calls.filter((call) => call.startsWith("inject "));
  const asks = (r: { agent: { calls: string[] } }) => r.agent.calls.filter((call) => call.startsWith("ask "));

  test("holding: it is refused and the answer resumes", async () => {
    const r = await midAnswer({ interruptOnSpeech: false });
    await r.c.heard("what is the tallest one");
    await tick();
    expect(r.said.join(" ")).toContain("I am still on the last one");
    expect(r.agent.calls).not.toContain("interrupt");
    expect(injected(r)).toEqual([]);
    expect(r.said).toContain("Two.");
    r.answer();
    await r.turn;
  });

  test("interrupting: the voice stops, and what he said goes into the turn with no interrupt", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("what is the tallest one");
    expect(injected(r)).toHaveLength(1);
    expect(r.agent.calls).not.toContain("interrupt");
    expect(asks(r)).toHaveLength(1);
    expect(r.said.join(" ")).not.toContain("I am still on the last one");
    expect(r.said).not.toContain("Two.");
    expect(r.said).not.toContain("Three.");
    r.answer();
    await r.turn;
  });

  test("interrupting: the note says where he stopped hearing, and that he said it while the agent worked", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("what is the tallest one");
    const text = injected(r)[0] ?? "";
    expect(text).toContain('The voice stopped mid-answer, after: "One."');
    expect(text).toContain("while you worked");
    expect(text).toContain("Do not repeat any of it");
    expect(text).toEndWith("\n\nwhat is the tallest one");
    // the note is for the agent; the transcript keeps what Chris actually said
    expect(r.channel.missed().some((entry) => entry.text === "what is the tallest one")).toBe(true);
    r.answer();
    await r.turn;
  });

  test("interrupting: the words the bridge sends say that they are Chris's (11.9.9)", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("what is the tallest one");
    expect(injected(r)).toEqual([
      'inject [Chris said this aloud while you worked. It is his message to you, not tool output. The voice stopped mid-answer, after: "One." He did not hear anything after that. Do not repeat any of it; he has it on screen and can ask for the rest. Act on what he says here.]\n\nwhat is the tallest one',
    ]);
    const args = r.agent.config()?.claudeArgs ?? [];
    expect(args[args.indexOf("--append-system-prompt") + 1]).toEndWith(
      "Chris can speak while you work. His words then reach you as a message the user sent while you were working, often beside a tool result. They are his words, not the tool's. Act on them.",
    );
    r.answer();
    await r.turn;
  });

  test("interrupting: two questions that go in as one message are remembered as one request (9.4.7)", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("what is the tallest one");
    await r.c.heard("and the longest");
    expect(injected(r)).toHaveLength(2);
    // 11.9.5 the process takes both at once, so one echo and one reply
    r.agent.hooks().onInjectedReply?.();
    r.agent.hooks().onDelta?.("The tallest is in Turkey, the longest in China. ");
    await tick();
    r.answer();
    await r.turn;
    await r.c.heard("sidetone where are we");
    await tick();
    expect(r.said.at(-1)).toBe("You asked: what is the tallest one and the longest I said: The tallest is in Turkey, the longest in China.");
  });

  test("interrupting: the record keeps the cutoff line, marked as injected", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("what is the tallest one");
    expect(r.c.measures.recent().filter((e) => e.kind === "cutoff")).toMatchObject([{ kind: "cutoff", interrupted: false, injected: true }]);
    r.answer();
    await r.turn;
  });

  test("interrupting: the rest of the message he spoke over is shown, not spoken", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("what is the tallest one");
    r.agent.hooks().onDelta?.("Four. ");
    await tick();
    expect(r.said).not.toContain("Four.");
    expect(r.told.some((m) => m.kind === "delta" && m.text === "Four. ")).toBe(true);
    r.answer();
    await r.turn;
    expect(r.said).not.toContain("Four.");
  });

  test("interrupting: the message begun after it is the reply, spoken as an answer of its own", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    const first = r.told.find((m) => m.kind === "sentence")!;
    await r.c.heard("what is the tallest one");
    r.agent.hooks().onInjectedReply?.();
    r.agent.hooks().onDelta?.("The tallest is in Turkey. ");
    await tick();
    expect(r.said.at(-1)).toBe("The tallest is in Turkey.");
    r.answer();
    await r.turn;
    const reply = r.told.find((m) => m.kind === "sentence" && m.text === "The tallest is in Turkey.")!;
    expect("answer" in reply && "answer" in first && reply.answer !== first.answer).toBe(true);
    // the turn is what Chris heard of the reply, under the reply's number
    expect(r.told.filter((m) => m.kind === "turn").at(-1)).toMatchObject({ text: "The tallest is in Turkey.", answer: "answer" in reply ? reply.answer : -1 });
    expect(r.cues.filter((cue) => cue === "done")).toHaveLength(1);
  });

  test("interrupting: a second question while the turn runs goes in the same way", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("what is the tallest one");
    r.agent.hooks().onInjectedReply?.();
    r.agent.hooks().onDelta?.("The tallest ");
    r.c.ears.stopSpeaking();
    await r.c.heard("and the longest");
    expect(injected(r)).toHaveLength(2);
    expect(r.agent.calls).not.toContain("interrupt");
    r.agent.hooks().onDelta?.("is in Turkey. ");
    r.agent.hooks().onInjectedReply?.();
    r.agent.hooks().onDelta?.("The longest is in China. ");
    await tick();
    expect(r.said).not.toContain("The tallest is in Turkey.");
    expect(r.said.at(-1)).toBe("The longest is in China.");
    r.answer();
    await r.turn;
  });

  test("interrupting: the result already back, only the voice was left, so it is a new turn", async () => {
    const r = await midAnswer({ interruptOnSpeech: true }, { inject: () => false });
    const heard = r.c.heard("what is the tallest one");
    r.answer();
    await heard;
    await r.turn;
    await tick();
    expect(asks(r)).toHaveLength(2);
    expect(asks(r)[1]).toContain('The voice stopped mid-answer, after: "One."');
    expect(asks(r)[1]).toEndWith("\n\nwhat is the tallest one");
    expect(r.c.measures.recent().filter((e) => e.kind === "cutoff")).toMatchObject([{ kind: "cutoff", interrupted: false, injected: false }]);
  });

  test("interrupting: a process that fails with an injection pending says so", async () => {
    const r = await midAnswer({ interruptOnSpeech: true }, { fail: "restarted: silent" });
    await r.c.heard("what is the tallest one");
    r.answer();
    await r.turn;
    await tick();
    expect(r.said.at(-1)).toBe("That turn did not finish.");
  });

  test("end the turn still interrupts", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("sidetone end the turn");
    expect(r.agent.calls).toContain("interrupt");
    expect(injected(r)).toEqual([]);
    r.answer();
    await r.turn;
  });

  test("10.7 at the agent's gate, speech refuses the gate first, then goes into the turn", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    r.agent.hooks().onPermission?.({ id: "r1", tool: "Bash", input: { command: "git push --force origin main" } });
    await r.c.heard("what is the tallest one");
    expect(r.agent.answers).toEqual([{ id: "r1", allow: false, message: expect.stringContaining('Chris said "what is the tallest one"') }]);
    expect(injected(r)).toHaveLength(1);
    r.answer();
    await r.turn;
  });

  test("8.6.3 the checkpoint still stops for the agreement word after an injection", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("what is the tallest one");
    r.agent.hooks().onCheckpoint?.(600_000);
    await r.c.heard("continue");
    expect(r.agent.calls).toContain("agree");
    expect(injected(r)).toHaveLength(1);
    r.answer();
    await r.turn;
  });

  test("carry on says the rest, once, without asking the agent again", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("what is the tallest one");
    await r.c.heard("sidetone carry on");
    await tick();
    expect(r.said).toContain("Two.");
    expect(r.said).toContain("Three.");
    expect(asks(r)).toHaveLength(1);
    expect(injected(r)).toHaveLength(1);
    await r.c.heard("sidetone carry on");
    expect(r.said.join(" ")).toContain("There is nothing left of it");
    r.answer();
    await r.turn;
  });

  test("the mode is a wake command, and it says which way it now is", async () => {
    const r = room({}, { interruptOnSpeech: false });
    await r.c.heard("sidetone interrupt on");
    await tick();
    expect(r.said).toContain("Interrupting on.");
    await r.c.heard("sidetone interrupt off");
    await tick();
    expect(r.said).toContain("Interrupting off.");
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
describe("what the bridge answers from itself (9.4.5, 9.4.7)", () => {
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
  const folder = mkdtempSync(join(tmpdir(), "hold-"));
  writeFileSync(join(folder, "hold.wav"), encodeWav(new Int16Array(4_800).fill(1_000), 48_000));
  const AFTER = 100;
  /** 15.7.5 a tool call and no words, so the turn is long and no sentence has moved the silence */
  const TOOL = (hooks: SessionHooks) => { hooks.onBlockStart?.("tool_use"); hooks.onBlockEnd?.(); };
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
  async function slow(overrides: Partial<Config> = {}, more: Partial<Music> = {}, during: (hooks: SessionHooks) => void = TOOL) {
    let end = () => {};
    const r = room({ during, hold: new Promise<void>((resolve) => { end = resolve; }) }, { holdMusicAfterMs: AFTER, ...overrides }, { folder, ...more });
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
    const r = await slow({ interruptOnSpeech: true });
    // item 4 the result is back and only the voice was left, so what Chris says
    // waits for the old turn to end and is the next one; the old turn runs on here
    r.c.agent.inject = () => false;
    void r.c.heard("what is the tallest one");
    await wait(AFTER * 2);
    expect(r.tracks).toHaveLength(0);
    r.end();
    await r.turn;
  });

  test("a muted bridge is left in peace", async () => {
    const r = room({ during: TOOL, hold: new Promise<void>(() => {}) }, { holdMusicAfterMs: AFTER }, { folder });
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

  test("a folder that is missing is said once and never tried again", async () => {
    let end = () => {};
    const r = room({ during: TOOL, hold: new Promise<void>((resolve) => { end = resolve; }) }, { holdMusicAfterMs: 20 }, { folder: "/nowhere/hold" });
    const turn = r.c.turn("something slow");
    await wait(200);
    expect(r.tracks).toHaveLength(0);
    expect(r.journal.filter((line) => line.startsWith("[no hold music:"))).toHaveLength(1);
    end();
    await turn;
  });

  test("a turn with no tool call gets no music, however slow (15.7.5)", async () => {
    const r = await slow({}, {}, () => {});
    await wait(AFTER * 3);
    expect(r.tracks).toHaveLength(0);
    r.end();
    await r.turn;
  });

  test("a turn that starts with a sentence and calls no tool gets no music (15.7.5)", async () => {
    const r = await slow({}, {}, (hooks) => hooks.onDelta?.("Checking now. "));
    await wait(AFTER * 3);
    expect(r.said).toEqual(["Checking now."]);
    expect(r.tracks).toHaveLength(0);
    r.end();
    await r.turn;
  });

  test("a reply that starts with a tool call is long, and the words after it are spoken as written (15.7.5)", async () => {
    let end = () => {};
    const r = room({
      during: (hooks) => { hooks.onBlockStart?.("tool_use"); hooks.onBlockEnd?.(); hooks.onBlockStart?.("text"); hooks.onDelta?.("Done. "); },
      hold: new Promise<void>((resolve) => { end = resolve; }),
    }, { holdMusicAfterMs: AFTER }, { folder });
    await r.mouth.music(() => true);
    const turn = r.c.turn("something slow");
    await until(() => r.tracks.length > 0);
    expect(r.tracks).toHaveLength(1);
    expect(r.said).toEqual(["Done."]);
    end();
    await turn;
  });

  test("a tool call partway through a reply makes the rest of the turn long (15.7.5)", async () => {
    let end = () => {};
    const r = room({
      during: (hooks) => { hooks.onDelta?.("Checking now. "); hooks.onBlockStart?.("tool_use"); hooks.onBlockEnd?.(); },
      hold: new Promise<void>((resolve) => { end = resolve; }),
    }, { holdMusicAfterMs: AFTER }, { folder });
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
    }, { holdMusicAfterMs: AFTER }, { folder });
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
    }, { holdMusicAfterMs: AFTER }, { folder });
    await r.c.turn("how much");
    expect(r.said).toEqual(["It costs 3.5 cents.", "Then more."]);
  });
  /**
   * Item 20: every audio file in the folder is a track. Each sample of a test
   * track holds its own time into the track in milliseconds, plus 10 000 for
   * "b", so the first sample played says which track played and from where.
   */
  describe("more than one track (item 20)", () => {
    const RATE = 16_000;
    const tracks = mkdtempSync(join(tmpdir(), "tracks-"));
    const ramp = (base: number) => encodeWav(Int16Array.from({ length: RATE * 5 }, (_, i) => base + Math.floor(i * 1_000 / RATE)), RATE);
    // written out of order, so the order below is the names' and not the writes'
    writeFileSync(join(tracks, "b.wav"), ramp(10_000));
    writeFileSync(join(tracks, "a.wav"), ramp(0));
    writeFileSync(join(tracks, "notes.txt"), "not a track");
    const first = (track: { wav: Uint8Array } | undefined) => decodeWav(track!.wav).samples[0];

    /**
     * A room with the folder, whose tracks play until `stop` is set, one at a
     * time. No fade in, so the first sample is the track's own.
     */
    function music(more: Partial<Music> = {}, overrides: Partial<Config> = {}) {
      const r = room({}, { holdMusicGain: 1, holdMusicFadeInMs: 0, ...overrides }, { folder: tracks, ...more });
      let stop = false;
      return {
        ...r,
        async play(): Promise<void> {
          stop = false;
          expect(await r.mouth.music(() => stop)).toBe(true);
        },
        async cut(): Promise<void> {
          stop = true;
          const track = r.tracks.at(-1)!;
          await until(() => track.stopped);
        },
      };
    }

    test("the tracks play in file-name order, one a stretch, and wrap around", async () => {
      const r = music();
      for (let i = 0; i < 3; i++) { await r.play(); await r.cut(); }
      expect(r.tracks.map(first)).toEqual([0, 10_000, 0]);
    });

    test("a track resumes two seconds before where it stopped", async () => {
      const r = music();
      const now = Date.now();
      setSystemTime(new Date(now));
      try {
        await r.play();
        setSystemTime(new Date(now + 3_500));
        await r.cut();
        await r.play();
        await r.cut();
        await r.play();
      } finally {
        setSystemTime();
      }
      await r.cut();
      expect(r.tracks.map(first)).toEqual([0, 10_000, 1_500]);
      // the rest of the track from there, not the whole track
      expect(decodeWav(r.tracks[2]!.wav).samples.length).toBe(RATE * 5 - RATE * 1.5);
    });

    test("the app's volume changes the gain of the next track, and is kept (item 28)", async () => {
      const r = music();
      await r.play(); await r.cut();
      r.c.set({ holdMusicGain: 0.5 });
      // out of range: not a volume the slider can send
      r.c.set({ holdMusicGain: 2 });
      await r.play(); await r.cut();
      expect(r.tracks.map(first)).toEqual([0, 5_000]);
      expect(r.patches).toEqual([{ holdMusicGain: 0.5 }]);
      expect(r.said).toEqual([]);
    });

    /** Item 52 the sample of a test track at `ms` into it, as the file holds it */
    const at = (base: number, ms: number) => (i: number) => base + Math.floor((ms * RATE / 1_000 + i) * 1_000 / RATE);

    test("each start rises from zero in a straight line over holdMusicFadeInMs (item 52)", async () => {
      const r = music({}, { holdMusicFadeInMs: 100 });
      for (let i = 0; i < 3; i++) { await r.play(); await r.cut(); }
      const length = RATE / 10;
      // a, then b, then a again from the start: the fade is on a copy, so the third is faded once, not twice
      for (const [n, base] of [[0, 0], [1, 10_000], [2, 0]] as const) {
        const samples = decodeWav(r.tracks[n]!.wav).samples;
        const own = at(base, 0);
        expect(samples[0]).toBe(0);
        for (const i of [1, 400, 800, 1_200, length - 1]) expect(samples[i]).toBe(Math.round(own(i) * i / length));
        expect(samples[length]).toBe(own(length));
      }
    });

    test("a resume fades in too (item 52)", async () => {
      const r = music({}, { holdMusicFadeInMs: 100 });
      const now = Date.now();
      setSystemTime(new Date(now));
      try {
        await r.play();
        setSystemTime(new Date(now + 3_500));
        await r.cut();
        await r.play();
        await r.cut();
        await r.play();
      } finally {
        setSystemTime();
      }
      await r.cut();
      const samples = decodeWav(r.tracks[2]!.wav).samples;
      const own = at(0, 1_500);
      expect(samples[0]).toBe(0);
      expect(samples[800]).toBe(Math.round(own(800) / 2));
      expect(samples[RATE / 10]).toBe(own(RATE / 10));
    });

    test("a fade in of zero leaves the samples as they were (item 52)", async () => {
      const r = music({}, { holdMusicFadeInMs: 0 });
      await r.play(); await r.cut();
      await r.play(); await r.cut();
      const own = at(10_000, 0);
      expect(Array.from(decodeWav(r.tracks[1]!.wav).samples)).toEqual(Array.from({ length: RATE * 5 }, (_, i) => own(i)));
    });

    test("a track that played to its end starts from the beginning next time", async () => {
      const r = music({ lasts: 20 });
      const now = Date.now();
      await r.play();
      await until(() => Date.now() - now > 40);
      await r.play(); await r.cut();
      await r.play(); await r.cut();
      expect(r.tracks.map(first)).toEqual([0, 10_000, 0]);
    });
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
    const r = room({}, {}, { folder: "/nowhere" });
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
    const r = room({}, {}, { folder: "/nowhere", lasts: 120 });
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
    const r = room({}, {}, { folder: "/nowhere" });
    r.mouth.play(wav);
    await until(() => r.tracks.length > 0);
    r.talk();
    await until(() => r.tracks[0]?.stopped === true);
    expect(r.tracks[0]?.stopped).toBe(true);
  });

  test("with the audio off it plays nothing at all (11.12)", async () => {
    const r = room({}, {}, { folder: "/nowhere" });
    r.mouth.setAudio(false);
    r.mouth.play(wav);
    await wait(60);
    expect(r.tracks).toHaveLength(0);
  });

  test("the record says when a track started and when it stopped (15.7)", async () => {
    const r = room({}, {}, { folder: "/nowhere" });
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

describe("the opener (11.6.5)", () => {
  const openers = { kept: ["Okay."], overrides: { ...config, openers: ["Okay."] } };

  test("a new turn's answer opens with the opener", async () => {
    const r = bridge({ ...openers, script: { deltas: ["It is fine."] } });
    await r.c.turn("is it fine");
    expect(r.said).toEqual(["Okay.", "It is fine."]);
  });

  test("an answer that ends while muted opens with nothing", async () => {
    let answer = () => {};
    const r = bridge({ ...openers, script: { deltas: ["It is fine."], hold: new Promise<void>((resolve) => { answer = resolve; }) } });
    const turn = r.c.turn("is it fine");
    await r.c.heard("sidetone mute");
    answer();
    await turn;
    expect(r.said).not.toContain("Okay.");
    expect(r.said).toContain("It is fine.");
  });

  test("the thinking cue waits its delay after the opener, not after the turn began", async () => {
    let answer = () => {};
    const r = bridge({
      kept: ["Okay."],
      overrides: { ...config, openers: ["Okay."], audioCueDelayMs: 60, audioCueEveryMs: 60 },
      script: {
        // the first sentence arrives at 40 ms; the turn runs on to 200 ms
        during: (hooks) => { setTimeout(() => { hooks.onBlockStart?.("text"); hooks.onDelta?.("It is fine. And "); }, 40); },
        hold: new Promise<void>((resolve) => { answer = resolve; }),
      },
    });
    const turn = r.c.turn("is it fine");
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(r.said[0]).toBe("Okay.");
    // 60 ms after the turn began is 20 ms after the opener: too soon
    expect(r.cues).not.toContain("thinking");
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(r.cues).toContain("thinking");
    answer();
    await turn;
  });
});
