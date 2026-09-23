import { describe, expect, setSystemTime, test } from "bun:test";
import { decode } from "../client/decode.js";
import { DEFAULTS, type Config } from "../src/config.ts";
import type { Outgoing } from "../src/messages.ts";
import { bridge, type Script } from "./harness.ts";

/**
 * 4.3 the control channel, as the bridge really sends it, written to
 * `test/fixtures/messages.jsonl` (ADR 0007).
 *
 * The contract was copied by eye into the page, the app and the fake phone,
 * and the app's test decoded messages that nobody had checked against the
 * bridge. The file is now the one copy: this test says the bridge still sends
 * it, and the page's `decode` below, `MessagesTest.kt` and the fake phone,
 * which reads messages with the page's `decode`, replay it. A change to what
 * the bridge sends fails here first. Write the file again with
 *
 *   WRITE_FIXTURE=1 bun test test/fixture.test.ts
 *
 * and the decoders then say whether they still read it.
 */
const FIXTURE = new URL("./fixtures/messages.jsonl", import.meta.url).pathname;
const config: Config = { ...DEFAULTS, historyMaxAgeMs: 60 * 60_000 };

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

/** Every kind the bridge sends, from the scenes that send it, in order. */
async function scenes(): Promise<Outgoing[]> {
  // 14.8 a kept line carries the time it was kept; a fixed clock keeps the file still
  setSystemTime(new Date("2026-09-21T14:05:59Z"));
  try {
    const script: Script = {};
    const r = bridge({ overrides: config, script });
    // a client joins an empty bridge, then a bridge that serves the app (17.15)
    r.channel.joined();
    r.channel.joined({ url: "https://bridge:3100/sidetone.apk", sha256: "ab12" });
    // 17.15.5 a build ends while the client is in the room
    r.channel.tell({ kind: "apk", apk: { url: "https://bridge:3100/sidetone.apk", sha256: "cd34" } });

    // 14.9 a turn in two blocks, split by a tool call, with the narration between
    script.during = (hooks) => {
      hooks.onBlockStart?.("text");
      hooks.onDelta?.("Let me look. ");
      hooks.onBlockEnd?.();
      hooks.onBlockStart?.("tool_use");
      hooks.onNarration?.("running Bash");
      hooks.onBlockEnd?.();
      hooks.onBlockStart?.("text");
      hooks.onDelta?.("Found it.");
      hooks.onBlockEnd?.();
    };
    script.text = "Let me look. Found it.";
    r.channel.receive({ kind: "said", text: "look and tell me" });
    await until(() => r.told.some((m) => m.kind === "turn"));

    // a turn that fails
    script.during = undefined;
    script.fail = "the agent died";
    r.channel.receive({ kind: "said", text: "and again" });
    await until(() => r.told.some((m) => m.kind === "error"));

    // 11.11 a turn nobody asked for streams under an answer of its own
    const hooks = r.agent.hooks();
    hooks.onBlockStart?.("text");
    hooks.onDelta?.("The build is green.");
    hooks.onBlockEnd?.();
    hooks.onUnprompted?.({ number: 2, text: "The build is green.", costUsd: 0.01, isError: false });
    // 17.17 a line queued by /say
    r.channel.tell({ kind: "narration", text: "Job build finished.", announce: true });
    // 18.9 a dead microphone
    r.channel.silence({ kind: "no frames", ms: 30_000 });
    // 14.8 a client that comes back is told what it missed
    r.channel.joined();
    await r.mouth.drained();

    // 14.10 the working sign, from the bridge's own tick while a turn runs.
    // Only the first one: a detached job on this machine can add more.
    let end = () => {};
    const slow = bridge({ overrides: config, script: { hold: new Promise<void>((resolve) => { end = resolve; }) } });
    const turn = slow.c.turn("something slow");
    await until(() => slow.told.some((m) => m.kind === "working"));
    end();
    await turn;
    // a working message is left out of the scenes above for the same reason
    return [...r.told.filter((m) => m.kind !== "working"), slow.told.find((m) => m.kind === "working")!];
  } finally {
    setSystemTime();
  }
}

const read = async () => (await Bun.file(FIXTURE).text()).trim().split("\n").map((line) => JSON.parse(line) as Outgoing);

describe("the control channel fixture (4.3, ADR 0007)", () => {
  test("the bridge still sends what the fixture holds", async () => {
    const sent = await scenes();
    if (process.env.WRITE_FIXTURE) await Bun.write(FIXTURE, `${sent.map((m) => JSON.stringify(m)).join("\n")}\n`);
    expect(sent).toEqual(await read());
    // every kind the bridge may send is in it, so no decoder can skip one
    const kinds = new Set(sent.map((m) => m.kind));
    const every: Array<Outgoing["kind"]> = ["heard", "sentence", "turn", "blockStart", "delta", "blockEnd", "narration", "error", "history", "rejoin", "working", "protocol", "settings", "speaking", "apk"];
    expect([...kinds].sort()).toEqual([...every].sort());
  }, 10_000);

  test("the page reads every message, and the transcript comes out right (14.7, 14.8)", async () => {
    const lines: string[] = [];
    let growing: { answer: number | undefined; at: number } | null = null;
    let endTurn = "";
    for (const message of await read()) {
      const shown = decode(message);
      expect(shown.line?.[0] ?? "").not.toStartWith("(unknown message");
      if (shown.endTurn !== undefined) endTurn = shown.endTurn;
      if (shown.history) for (const [text, kind] of shown.history) lines.push(`${kind}: ${text}`);
      if (shown.line) lines.push(`${shown.line[1]}: ${shown.line[0]}`);
      if (shown.sentence) {
        const [text, answer] = shown.sentence;
        if (growing && growing.answer === answer) lines[growing.at] += ` ${text}`;
        else { growing = { answer, at: lines.length }; lines.push(`bridge: ${text}`); }
      }
      if (shown.answered) {
        const [text, answer] = shown.answered;
        if (growing && growing.answer === answer) lines[growing.at] = `bridge: ${text}`;
        else lines.push(`bridge: ${text}`);
        growing = null;
      }
    }
    expect(endTurn).toBe("sidetone end the turn");
    expect(lines).toEqual([
      "you: look and tell me",
      // the page grows one line for the answer, begun with its first sentence
      "bridge: Let me look. Found it.",
      "note: running Bash",
      "you: and again",
      "note: the agent died",
      "bridge: The build is green.",
      "note: Job build finished.",
      // 14.8 the history the returning client is given
      "you: look and tell me",
      "bridge: Let me look. Found it.",
      "you: and again",
      "bridge: The build is green.",
    ]);
  });
});
