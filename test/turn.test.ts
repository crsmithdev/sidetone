import { describe, expect, test } from "bun:test";
import { DEFAULTS, type Config } from "../src/config.ts";
import { Conversation, type Agent, type MakeAgent } from "../src/conversation.ts";
import { Measures } from "../src/measures.ts";
import { Mouth, type Speaker } from "../src/mouth.ts";
import type { SessionHooks, Turn } from "../src/session.ts";

const config: Config = { ...DEFAULTS, audioCueDelayMs: 10, audioCueEveryMs: 10 };
const engines = { start: async () => {}, transcribe: async () => "", synthesize: async () => "", stop: () => {} };

interface Script {
  deltas?: string[];
  text?: string;
  rateLimit?: { fiveHour: number; sevenDay: number };
  /** what the agent does before it answers, such as reaching the checkpoint */
  during?: (hooks: SessionHooks) => void;
  /** a turn that is still running: it answers when this resolves */
  hold?: Promise<void>;
  /** what the real process does with an interrupt: it returns a result */
  onInterrupt?: () => void;
  fail?: string;
}

/**
 * The agent, scripted. This is the whole point of the seam: a turn can be
 * driven — word by word, through a checkpoint, into a restart — with no
 * Claude Code process anywhere near it.
 */
function scripted(script: Script = {}) {
  const calls: string[] = [];
  let hooks: SessionHooks = {};
  const agent: Agent = {
    start: () => calls.push("start"),
    stop: () => calls.push("stop"),
    async ask(said: string): Promise<Turn> {
      calls.push(`ask ${said}`);
      script.during?.(hooks);
      if (script.hold) await script.hold;
      for (const delta of script.deltas ?? []) hooks.onDelta?.(delta);
      if (script.fail) throw new Error(script.fail);
      return { number: 1, text: script.text ?? (script.deltas ?? []).join(""), costUsd: 0.02, isError: false };
    },
    agree: () => calls.push("agree"),
    interrupt: () => { calls.push("interrupt"); script.onInterrupt?.(); },
    restart: (reason: string) => calls.push(`restart ${reason}`),
    running: true,
    turns: 1,
    rateLimit: script.rateLimit ?? { fiveHour: 0, sevenDay: 0 },
    contextFraction: () => null,
    totalCostUsd: () => 0.5,
  };
  const make: MakeAgent = (given) => { hooks = given; return agent; };
  return { make, calls, hooks: () => hooks };
}

function room(script: Script = {}, overrides: Partial<Config> = {}) {
  const said: string[] = [];
  const cues: string[] = [];
  const told: Array<Record<string, unknown>> = [];
  const agent = scripted(script);
  const speaker: Speaker = {
    async play(text) { said.push(text); return true; },
    cue(wav) { cues.push(wav); },
  };
  const settings = { ...config, ...overrides };
  const mouth = new Mouth(speaker, { take: async (text: string) => text, start: () => {} }, { file: (name) => name }, new Measures(), settings);
  const turns: Turn[] = [];
  const c = new Conversation("/tmp", settings, mouth, engines as never,
    { onTurn: (turn) => turns.push(turn), tell: (value) => { told.push(value); } }, agent.make);
  return { c, said, cues, turns, agent, told };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

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
    expect(r.c.missed().at(-1)).toMatchObject({ kind: "turn", number: 1, text: "Four." });
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
    const sentences = r.told.filter((value) => value.kind === "sentence").map((value) => value.text);
    expect(sentences).toEqual(["Two plus two is four.", "It always was."]);
    expect(r.told.find((value) => value.kind === "turn")).toMatchObject({ text: "Two plus two is four. It always was." });
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
    await r.c.heard("hey bridge clear the context");
    expect(r.said.at(-1)).toContain("I am about to clear the context");
    expect(r.agent.calls).not.toContain("restart cleared by voice");
  });

  test("the agreement word clears it", async () => {
    const r = room();
    await r.c.heard("hey bridge clear the context");
    await r.c.heard("continue");
    expect(r.agent.calls).toContain("restart cleared by voice");
  });

  test("anything else does not, and says so (10.5)", async () => {
    const r = room();
    await r.c.heard("hey bridge clear the context");
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
    r.c.stopSpeaking();
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

  test("interrupting: the agent is told where Chris stopped hearing, and the question is clean", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("what is the tallest one");
    const asked = r.agent.calls.filter((call) => call.startsWith("ask ")).at(-1) ?? "";
    expect(asked).toContain('The voice stopped mid-answer, after: "One."');
    // 18 September: told only that he missed the rest, the agent said it again
    expect(asked).toContain("Do not repeat any of it");
    expect(asked).toContain("what is the tallest one");
    // the note is for the agent; the transcript keeps what Chris actually said
    expect(r.c.missed().some((entry) => entry.text === "what is the tallest one")).toBe(true);
  });

  test("interrupting: what was not spoken reaches the client as text", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("what is the tallest one");
    const note = r.told.find((value) => String(value.text ?? "").startsWith("not spoken:"));
    expect(String(note?.text)).toBe("not spoken: Two. Three.");
  });

  test("carry on says the rest, once, without asking the agent again", async () => {
    const r = await midAnswer({ interruptOnSpeech: true });
    await r.c.heard("what is the tallest one");
    const asks = r.agent.calls.filter((call) => call.startsWith("ask ")).length;
    await r.c.heard("hey bridge carry on");
    await tick();
    expect(r.said).toContain("Two.");
    expect(r.said).toContain("Three.");
    expect(r.agent.calls.filter((call) => call.startsWith("ask ")).length).toBe(asks);
    await r.c.heard("hey bridge carry on");
    expect(r.said.join(" ")).toContain("There is nothing left of it");
  });

  test("the mode is a wake command, and it says which way it now is", async () => {
    const r = room({}, { interruptOnSpeech: false });
    await r.c.heard("hey bridge interrupt on");
    await tick();
    expect(r.said).toContain("Interrupting on.");
    await r.c.heard("hey bridge interrupt off");
    await tick();
    expect(r.said).toContain("Interrupting off.");
    await r.c.heard("hey bridge interrupt");
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
    r.c.stopSpeaking();
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

  test("it is spoken, sentence by sentence, and reaches the client", async () => {
    const r = room();
    r.agent.hooks().onUnprompted?.(turnOf("The search finished. It found nine files."));
    await tick();
    expect(r.said).toEqual(["The search finished.", "It found nine files."]);
    expect(r.told.some((value) => value.kind === "turn" && String(value.text).startsWith("The search finished"))).toBe(true);
  });

  test("it jumps a hold, because news is not the answer it landed on", async () => {
    const r = room();
    r.c.stopSpeaking();
    r.agent.hooks().onUnprompted?.(turnOf("The build is green."));
    await tick();
    expect(r.said).toContain("The build is green.");
  });

  test("talked over, it is said once and waits, rather than spinning", async () => {
    // the drive of 18 September: one refusal, eighteen times in three seconds
    const r = room();
    r.c.stopSpeaking();
    r.agent.hooks().onUnprompted?.(turnOf("The build is green."));
    await tick();
    await tick();
    expect(r.said.filter((line) => line === "The build is green.").length).toBe(1);
  });

  test("an empty one and a failed one say nothing", async () => {
    const r = room();
    r.agent.hooks().onUnprompted?.(turnOf("   "));
    r.agent.hooks().onUnprompted?.(turnOf("It broke.", true));
    await tick();
    expect(r.said).toEqual([]);
  });
});
