import { describe, expect, test } from "bun:test";
import type { Outgoing } from "../src/messages.ts";
import { MAX_MESSAGE_BYTES, Outbound } from "../src/outbound.ts";

/** The room, written down: what went out, and a publish that can be made to fail. */
function room(fail?: (payload: Uint8Array, count: number) => string | null) {
  const sent: Array<Record<string, unknown>> = [];
  const journal: string[] = [];
  let count = 0;
  const out = new Outbound(async (payload) => {
    const reason = fail?.(payload, ++count);
    if (reason) throw new Error(reason);
    sent.push(JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>);
  }, (line) => journal.push(line));
  return { out, sent, journal };
}

const turn = (number: number, words: number) => ({
  kind: "turn" as const, number, text: `turn ${number} ${"word ".repeat(words)}`, costUsd: 0.01, at: number,
});

describe("one exit for the control channel (14.11)", () => {
  test("a failed publish is a journal line, not a rejection", async () => {
    // the rejection this catches exits the process: Bun prints it and returns 1
    const r = room((_payload, count) => (count === 1 ? "the room is gone" : null));
    r.out.send({ kind: "narration", text: "one" });
    r.out.send({ kind: "narration", text: "two" });
    await r.out.drained();
    expect(r.journal).toEqual(["[a narration message did not reach the client: the room is gone]"]);
    // the next message still goes: one failure does not end the channel
    expect(r.sent).toEqual([{ kind: "narration", text: "two" }]);
  });

  test("the messages go out in the order they were given (14.9)", async () => {
    // a slow first publish must not let the second overtake it: a delta has to
    // reach the client before the sentence that finishes with it
    const r = room();
    const slow = new Outbound(async (payload) => {
      if (JSON.parse(new TextDecoder().decode(payload)).text === "half a ") await Bun.sleep(20);
      r.sent.push(JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>);
    });
    slow.send({ kind: "delta", answer: 1, block: 1, text: "half a " });
    slow.send({ kind: "sentence", answer: 1, text: "half a sentence." });
    await slow.drained();
    expect(r.sent.map((message) => message.kind)).toEqual(["delta", "sentence"]);
  });

  test("a history too large for one message keeps the newest turns (14.8)", async () => {
    const r = room();
    const turns = Array.from({ length: 40 }, (_, index) => turn(index + 1, 800));
    const whole: Outgoing = { kind: "history", turns };
    expect(new TextEncoder().encode(JSON.stringify(whole)).byteLength).toBeGreaterThan(MAX_MESSAGE_BYTES);
    r.out.send(whole);
    await r.out.drained();
    const kept = r.sent[0]?.turns as Array<{ number: number }>;
    expect(new TextEncoder().encode(JSON.stringify(r.sent[0])).byteLength).toBeLessThanOrEqual(MAX_MESSAGE_BYTES);
    // the newest are the ones a returning client wants
    expect(kept.at(-1)?.number).toBe(40);
    expect(kept.length).toBeLessThan(40);
    expect(r.journal[0]).toContain("trimmed to the newest");
  });

  test("a history that already fits is sent whole", async () => {
    const r = room();
    r.out.send({ kind: "history", turns: [turn(1, 3), turn(2, 3)] });
    await r.out.drained();
    expect((r.sent[0]?.turns as unknown[]).length).toBe(2);
    expect(r.journal).toEqual([]);
  });

  test("another kind over the limit goes anyway, and says so", async () => {
    // the true limit is a comment, not a measurement: a transcript trimmed on
    // a guess is worse than a large message
    const r = room();
    r.out.send({ kind: "turn", number: 1, text: "word ".repeat(20_000), costUsd: 0.01 });
    await r.out.drained();
    expect(r.sent.length).toBe(1);
    expect(r.journal[0]).toContain(`over the ${MAX_MESSAGE_BYTES} a data message carries`);
  });
});
