import { describe, expect, test } from "bun:test";
import { DEFAULTS, type Config } from "../src/config.ts";
import { Conversation, type Agent, type MakeAgent } from "../src/conversation.ts";
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
    interrupt: () => calls.push("interrupt"),
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
  const agent = scripted(script);
  const mouth = {
    say: async (text: string) => { said.push(text); return true; },
    cue: (name: string) => { cues.push(name); },
    tell: () => {},
  };
  const turns: Turn[] = [];
  const c = new Conversation("/tmp", { ...config, ...overrides }, mouth as never, engines as never, engines as never,
    { onTurn: (turn) => turns.push(turn) }, agent.make);
  return { c, said, cues, turns, agent };
}

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
    expect(r.agent.calls).not.toContain("restart cleared by voice");
    expect(r.said.at(-1)).toContain("Nothing was cleared.");
  });
});
