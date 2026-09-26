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
    microphone: (on, hold) => { did.push(`microphone ${on}${hold ? " hold" : ""}`); },
    voice: (on) => { did.push(`voice ${on}`); },
    setting: (patch) => { did.push(`setting ${JSON.stringify(patch)}`); },
    music: (on) => { did.push(`music ${on}`); },
    quality: (side, quality) => { did.push(`quality ${side} ${quality}`); return news; },
    screen: (part) => { did.push(`screen ${String(part.id)}`); return ["screen said"]; },
    screenshot: (part) => { did.push(`screenshot ${String(part.id)}`); return ["screenshot said"]; },
    crash: (report) => { did.push(`crash ${String(report.id)}`); return "crash said"; },
    device: async (value) => { did.push(`device ${String(value.model)}`); return "device said"; },
  };
  const c = new Channel({ ...config, ...overrides }, (message) => sent.push(message), ends, (line) => journal.push(line));
  return { c, sent, journal, did, sameQuality: () => { news = false; } };
}

describe("what a client is told (4.3, 14.7)", () => {
  test("a join gets the words to say back, then what it missed, and only the words said and answered", () => {
    const { c, sent } = channel();
    c.tell({ kind: "heard", text: "what is two plus two" });
    c.tell({ kind: "sentence", text: "Four.", answer: 1 });
    // 14.9 the words of a block are sent and not kept: the turn that closes the answer is the kept line
    c.tell({ kind: "blockStart", answer: 1, block: 1 });
    c.tell({ kind: "delta", text: "Four.", answer: 1, block: 1, seq: 1 });
    c.tell({ kind: "blockEnd", answer: 1, block: 1 });
    c.tell({ kind: "turn", number: 1, text: "Four.", costUsd: 0.01, answer: 1 });
    c.narrate("the search finished");
    c.tell({ kind: "error", text: "the agent stopped" });
    sent.length = 0;
    c.joined();
    expect(sent[0]).toMatchObject({ kind: "protocol", endTurn: `${config.wakeWord} end the turn` });
    // 14.16 whether the bridge still loads, so the app does not show "listening" too soon
    expect(sent[1]).toEqual({ kind: "starting", on: true });
    // 9.4.9 a client that shows a setting is told what is in force before the history
    expect(sent[2]).toMatchObject({ kind: "settings" });
    expect(sent[3]?.kind).toBe("history");
    const turns = sent[3]?.kind === "history" ? sent[3].turns : [];
    expect(turns.map((t) => `${t.kind} ${t.text}`)).toEqual(["heard what is two plus two", "turn Four."]);
  });

  test("14.16 a client hears that the bridge loads, and hears once when the load ends", () => {
    const { c, sent } = channel();
    // no client was told the bridge starts, so no client is owed the end of it
    const quiet = channel();
    quiet.c.ready();
    expect(quiet.sent).toEqual([]);
    c.joined();
    expect(sent.filter((m) => m.kind === "starting")).toEqual([{ kind: "starting", on: true }]);
    sent.length = 0;
    c.ready();
    expect(sent).toEqual([{ kind: "starting", on: false }]);
    sent.length = 0;
    // a client that joins after the load is told at once that it is over
    c.joined();
    expect(sent.filter((m) => m.kind === "starting")).toEqual([{ kind: "starting", on: false }]);
  });

  test("each settings message has a larger seq than the last, so the app can drop an old one (9.4.9.1)", () => {
    const { c, sent } = channel();
    c.settings();
    c.settings();
    const seqs = sent.flatMap((message) => (message.kind === "settings" ? [message.seq] : []));
    expect(seqs).toHaveLength(2);
    expect(seqs[1]).toBeGreaterThan(seqs[0] as number);
    expect(seqs[0]).toBeGreaterThanOrEqual(Date.now() - 1_000);
  });

  test("a narration reaches the client once and the journal once", () => {
    const { c, sent, journal } = channel();
    c.narrate("the wake word arrived with no command");
    expect(sent).toEqual([{ kind: "narration", text: "the wake word arrived with no command" }]);
    expect(journal).toEqual(["[the wake word arrived with no command]"]);
  });
});

describe("what a client says about its screen (14.11)", () => {
  test("screen log entries go to the screen end, and what it says reaches the journal only", () => {
    const { c, did, sent, journal } = channel();
    c.receive({ kind: "screen", id: "a1", entries: [] });
    expect(did).toEqual(["screen a1"]);
    expect(sent).toEqual([]);
    expect(journal).toEqual(["[screen said]"]);
  });

  test("14.12 a part of a screenshot goes to the screenshot end, and what it says reaches the journal only", () => {
    const { c, did, sent, journal } = channel();
    c.receive({ kind: "screenshot", id: "a1", part: 1, of: 1, data: "" });
    expect(did).toEqual(["screenshot a1"]);
    expect(sent).toEqual([]);
    expect(journal).toEqual(["[screenshot said]"]);
  });

  test("14.14 a crash report goes to the crash end, and what it says reaches the journal only", () => {
    const { c, did, sent, journal } = channel();
    c.receive({ kind: "crash", id: "a1", text: "" });
    expect(did).toEqual(["crash a1"]);
    expect(sent).toEqual([]);
    expect(journal).toEqual(["[crash said]"]);
  });

  test("14.15 what the phone says about itself goes to the device end, and what it says reaches the journal only", async () => {
    const { c, did, sent, journal } = channel();
    c.receive({ kind: "device", model: "Pixel 8", aec: true, canceller: "software", route: "speaker" });
    await Promise.resolve();
    expect(did).toEqual(["device Pixel 8"]);
    expect(sent).toEqual([]);
    expect(journal).toEqual(["[device said]"]);
  });

  test("14.10 the working message is sent, and is not kept for a client that joins later", () => {
    const { c, sent } = channel();
    c.tell({ kind: "working", on: true });
    expect(sent).toEqual([{ kind: "working", on: true }]);
    sent.length = 0;
    c.joined();
    expect(c.missed()).toEqual([]);
  });
});

describe("what a client missed (14.8)", () => {
  test("a drop in a tunnel is minutes, so recent turns come back", () => {
    const { c } = channel();
    const now = Date.now();
    c.tell({ kind: "turn", number: 1, text: "recent", costUsd: 0, answer: 1 });
    expect(c.missed(now + 30_000).map((e) => e.text)).toEqual(["recent"]);
  });
  test("an exchange from hours ago is not something this client missed", () => {
    const { c } = channel();
    c.tell({ kind: "turn", number: 1, text: "hours ago", costUsd: 0, answer: 1 });
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

  test("9.5.2 a cut that says release ends the utterance, and the journal says so", () => {
    const { c, did, journal } = channel();
    c.receive({ kind: "mic", on: false, release: true });
    expect(did).toEqual(["microphone false hold"]);
    expect(journal).toEqual(["[the phone cut its microphone and ended the utterance]"]);
  });

  test("9.5.2 an open never releases, whatever the message says", () => {
    const { c, did } = channel();
    c.receive({ kind: "mic", on: true, release: true });
    expect(did).toEqual(["microphone true"]);
  });

  test("15.14 an open that says hold is a hold to talk button pressed", () => {
    const { c, did } = channel();
    c.receive({ kind: "mic", on: true, hold: true });
    expect(did).toEqual(["microphone true hold"]);
  });

  test("15.14 a cut is a hold only when it says release", () => {
    const { c, did } = channel();
    c.receive({ kind: "mic", on: false, hold: true });
    expect(did).toEqual(["microphone false"]);
  });

  test("the audio off leaves the words, and says so in the journal only (4.3.1)", () => {
    const { c, did, sent, journal } = channel();
    c.receive({ kind: "voice", on: false });
    expect(did).toEqual(["voice false"]);
    expect(sent).toEqual([]);
    expect(journal).toEqual(["[the audio is off; the words carry on in the transcript]"]);
  });

  test("the music button reaches the hold music, and says so in the journal only (4.3.1)", () => {
    const { c, did, sent, journal } = channel();
    c.receive({ kind: "music", on: false });
    c.receive({ kind: "music", on: true });
    expect(did).toEqual(["music false", "music true"]);
    expect(sent).toEqual([]);
    expect(journal).toEqual(["[the hold music is off]", "[the hold music is on]"]);
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
    const { c, sent, journal } = channel();
    c.silence(null);
    c.silence({ kind: "no frames", ms: 30_000 });
    c.silence({ kind: "no frames", ms: 40_000 });
    // 18.9.2 the client gets the rejoin and no note; the journal keeps the words
    expect(sent.map((m) => m.kind)).toEqual(["rejoin"]);
    expect(journal).toContain("[no audio from the phone for 30s, though it says its microphone is open. Leave the room and rejoin to publish a new track]");
    c.silence(null);
    c.silence({ kind: "silence", ms: 31_000 });
    expect(sent.map((m) => m.kind)).toEqual(["rejoin", "rejoin"]);
    expect(journal).toContain("[the phone's microphone has carried no sound at all for 31s. Leave the room and rejoin to publish a new track]");
  });

  test("18.9 the phone is asked to rejoin once, and the journal says so in one line", () => {
    const { c, sent, journal } = channel();
    c.silence({ kind: "silence", ms: 30_000 });
    c.silence({ kind: "silence", ms: 40_000 });
    expect(sent.filter((m) => m.kind === "rejoin")).toEqual([{ kind: "rejoin" }]);
    expect(journal.filter((line) => line.includes("rejoin") && line.startsWith("[asked"))).toEqual(["[asked the phone to rejoin]"]);
  });

  test("18.9 a microphone the phone cut is not asked to rejoin", () => {
    const { c, sent } = channel();
    c.receive({ kind: "mic", on: false });
    c.silence({ kind: "silence", ms: 30_000 });
    expect(sent.filter((m) => m.kind === "rejoin")).toEqual([]);
  });

  test("a microphone the phone says it cut is not a fault", () => {
    const { c, sent } = channel();
    c.receive({ kind: "mic", on: false });
    c.silence({ kind: "no frames", ms: 30_000 });
    expect(sent).toEqual([]);
  });
});
