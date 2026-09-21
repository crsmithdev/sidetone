import { describe, expect, test } from "bun:test";
import { Channel, type Ends } from "../src/channel.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import type { Outgoing } from "../src/messages.ts";

const config: Config = { ...DEFAULTS, historyMaxAgeMs: 60_000 };

/** A channel over an array, with the three ends written down instead of acted on. */
function channel(overrides: Partial<Config> = {}) {
  const sent: Outgoing[] = [];
  const journal: string[] = [];
  const did: string[] = [];
  let news = true;
  const ends: Ends = {
    heard: async (text) => { did.push(`heard ${text}`); },
    microphone: (on) => { did.push(`microphone ${on}`); },
    voice: (on) => { did.push(`voice ${on}`); },
    quality: (side, quality) => { did.push(`quality ${side} ${quality}`); return news; },
  };
  const c = new Channel({ ...config, ...overrides }, (message) => sent.push(message), ends, (line) => journal.push(line));
  return { c, sent, journal, did, sameQuality: () => { news = false; } };
}

describe("what a client is told (4.3, 14.7)", () => {
  test("a join gets the words to say back, then what it missed, and only the words said and answered", () => {
    const { c, sent } = channel();
    c.tell({ kind: "heard", text: "what is two plus two" });
    c.tell({ kind: "sentence", text: "Four.", answer: 1 });
    c.tell({ kind: "turn", number: 1, text: "Four.", costUsd: 0.01 });
    c.narrate("the search finished");
    c.tell({ kind: "error", text: "the agent stopped" });
    sent.length = 0;
    c.joined();
    expect(sent[0]).toMatchObject({ kind: "protocol", endTurn: `${config.wakeWord} end the turn` });
    expect(sent[1]?.kind).toBe("history");
    const turns = sent[1]?.kind === "history" ? sent[1].turns : [];
    expect(turns.map((t) => `${t.kind} ${t.text}`)).toEqual(["heard what is two plus two", "turn Four."]);
  });

  test("a narration reaches the client once and the journal once", () => {
    const { c, sent, journal } = channel();
    c.narrate("the wake word arrived with no command");
    expect(sent).toEqual([{ kind: "narration", text: "the wake word arrived with no command" }]);
    expect(journal).toEqual(["[the wake word arrived with no command]"]);
  });
});

describe("what a client missed (14.8)", () => {
  test("a drop in a tunnel is minutes, so recent turns come back", () => {
    const { c } = channel();
    const now = Date.now();
    c.tell({ kind: "turn", number: 1, text: "recent", costUsd: 0 });
    expect(c.missed(now + 30_000).map((e) => e.text)).toEqual(["recent"]);
  });
  test("an exchange from hours ago is not something this client missed", () => {
    const { c } = channel();
    c.tell({ kind: "turn", number: 1, text: "hours ago", costUsd: 0 });
    const later = Date.now() + 7_200_000;
    // replaying the old one arrives looking like the conversation in progress
    expect(c.missed(later).map((e) => e.text)).toEqual([]);
  });
});

describe("what a client sends (4.3)", () => {
  test("what was typed reaches the conversation as speech", () => {
    const { c, did } = channel();
    c.receive({ kind: "said", text: "sidetone, stats" });
    expect(did).toEqual(["heard sidetone, stats"]);
  });

  test("a microphone cut resets the ear and is written to the journal", () => {
    const { c, did, journal, sent } = channel();
    c.receive({ kind: "mic", on: false });
    c.receive({ kind: "mic", on: true });
    expect(did).toEqual(["microphone false", "microphone true"]);
    expect(journal).toEqual(["[the phone cut its microphone]", "[the phone opened its microphone]"]);
    expect(sent).toEqual([]);
  });

  test("the voice off leaves the words, and says so where the words are", () => {
    const { c, did, sent } = channel();
    c.receive({ kind: "voice", on: false });
    expect(did).toEqual(["voice false"]);
    expect(sent).toEqual([{ kind: "narration", text: "the voice is off; the words carry on in the transcript" }]);
  });

  test("the connection is said when it changes and not when it repeats", () => {
    const { c, did, journal, sameQuality } = channel();
    c.receive({ kind: "quality", quality: "poor" });
    expect(did).toEqual(["quality phone poor"]);
    expect(journal).toEqual(["[the phone reports poor]"]);
    sameQuality();
    c.quality("bridge", "excellent");
    expect(journal).toHaveLength(1);
  });

  test("a kind this end does not know is dropped", () => {
    const { c, did, sent } = channel();
    c.receive({ kind: "wobble" });
    expect(did).toEqual([]);
    expect(sent).toEqual([]);
  });
});

describe("18 a microphone that stopped", () => {
  test("it is said once, and again only after the microphone came back", () => {
    const { c, sent } = channel();
    c.silence(null);
    c.silence({ kind: "no frames", ms: 30_000 });
    c.silence({ kind: "no frames", ms: 40_000 });
    expect(sent.map((m) => m.kind)).toEqual(["narration"]);
    expect(sent[0]).toMatchObject({ text: "no audio from the phone for 30s, though it says its microphone is open. Leave the room and rejoin to publish a new track" });
    c.silence(null);
    c.silence({ kind: "silence", ms: 31_000 });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ text: "the phone's microphone has carried no sound at all for 31s. Leave the room and rejoin to publish a new track" });
  });

  test("a microphone the phone says it cut is not a fault", () => {
    const { c, sent } = channel();
    c.receive({ kind: "mic", on: false });
    c.silence({ kind: "no frames", ms: 30_000 });
    expect(sent).toEqual([]);
  });
});
