/**
 * The drive card's tests that need no car (docs/testing.md, "The drive card").
 *
 * Each test on the card is something Chris does in the car and the bridge
 * checks from the journal and the record. Some of them check only the bridge:
 * a command said, a button tapped, a restart, a track asked for. These run
 * here through the assembly the car runs, with the phone's messages as the
 * phone sends them. What stays in the car is the hearing: whisper on Chris's
 * voice through the car, the phone's canceller, and what he hears.
 *
 * Each describe names its test on the card.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav } from "../src/audio.ts";
import { Pairing, routes } from "../src/routes.ts";
import { Shown } from "../src/shown.ts";
import { fakeClock, settle, until } from "./clock.ts";
import { bridge, RATE } from "./harness.ts";

fakeClock();
const tick = settle;

/** The `setting` lines of the record, as the drive card greps them. */
const settingLines = (r: ReturnType<typeof bridge>) => r.measures.recent(200).flatMap((e) => (e.kind === "setting" ? [e] : []));

describe("drive test 10: the record knows which setting was in force", () => {
  /** The bridge and its /diagnostics, wired as serve.ts wires them. */
  function site() {
    const r = bridge();
    const handle = routes({
      config: r.config,
      bridge: r,
      pairing: new Pairing("kelp-cedar-jetty", async () => ({ token: "t", url: "wss://bridge:7880", room: "sidetone" })),
      page: "",
      files: { sdk: "/nowhere", decoder: "/nowhere", apk: "/nowhere" },
      health: () => ({ room: true, speech: true, transcription: true, microphone: true, sinceSound: 0 }),
      shown: new Shown("/nowhere", "https://bridge:3100"),
      startedAt: Date.now(),
    });
    const diagnostics = async () => (await (await handle(new Request("http://bridge/diagnostics"), "127.0.0.1")).json()) as { settings: Record<string, unknown> };
    return { ...r, diagnostics };
  }

  // the male voice is the default, so the change is to the female one
  test("\"sidetone, female voice\" is a setting line, and /diagnostics shows the new voice", async () => {
    const r = site();
    const before = (await r.diagnostics()).settings.ttsVoice;
    await r.c.heard("sidetone female voice");
    const female = r.config.voiceChoices.female;
    expect(female).not.toBe(before);
    expect((await r.diagnostics()).settings.ttsVoice).toBe(female);
    expect(settingLines(r).map((e) => e.patch)).toContainEqual({ ttsVoice: female });
  });

  test("\"sidetone, interrupt on\" is a setting line, and /diagnostics shows it on", async () => {
    const r = site();
    expect((await r.diagnostics()).settings.interruptOnSpeech).toBe(false);
    await r.c.heard("sidetone interrupt on");
    expect((await r.diagnostics()).settings.interruptOnSpeech).toBe(true);
    expect(settingLines(r).map((e) => e.patch)).toContainEqual({ interruptOnSpeech: true });
  });
});

describe("drive test 12: the audio goes off and comes back", () => {
  test("off, the answer is words and no voice; on, the next answer is spoken; each tap is a setting line", async () => {
    const r = bridge({ script: { deltas: ["It is sunny. ", "Take a hat."] } });
    r.channel.receive({ kind: "voice", on: false });
    await r.c.turn("what is the weather");
    expect(r.said).toEqual(["It is sunny.", "Take a hat."]);
    expect(r.voiced).toEqual([]);
    expect(r.told.flatMap((m) => (m.kind === "sentence" ? [m.text] : []))).toEqual(["It is sunny.", "Take a hat."]);

    r.channel.receive({ kind: "voice", on: true });
    await r.c.turn("and tomorrow");
    expect(r.voiced).toEqual(["It is sunny.", "Take a hat."]);

    expect(r.journal).toContain("[the audio is off; the words carry on in the transcript]");
    expect(r.journal.indexOf("[the audio is on]")).toBeGreaterThan(r.journal.indexOf("[the audio is off; the words carry on in the transcript]"));
    expect(settingLines(r).map((e) => e.patch)).toEqual([{ audio: false }, { audio: true }]);
  });
});

describe("drive test 14: interrupting a finished answer stays quiet about it", () => {
  test("a follow-up after an answer played out has no not spoken line", async () => {
    const r = bridge({ script: { deltas: ["The first answer. ", "It has two sentences."] }, overrides: { interruptOnSpeech: true } });
    await r.c.turn("the first question");
    await until(() => r.said.length === 2);
    await r.c.heard("a follow-up question");
    await until(() => r.agent.calls.filter((call) => call.startsWith("ask")).length === 2);
    expect(r.journal.filter((line) => line.includes("not spoken:"))).toEqual([]);
  });

  test("talking over an answer still playing is the one time it is said", async () => {
    let end = () => {};
    const r = bridge({
      script: {
        during: (hooks) => { for (const delta of ["The first sentence is here. ", "The second one follows it. ", "A third ends it. "]) hooks.onDelta?.(delta); },
        hold: new Promise<void>((resolve) => { end = resolve; }),
      },
      overrides: { interruptOnSpeech: true },
    });
    r.stt.transcribe = async () => "stop, another question";
    // the first sentence is still playing when Chris talks over it
    r.blockSay(true);
    const turn = r.c.turn("count to three");
    await until(() => r.said.length > 0);
    r.talk();
    r.hush();
    await until(() => r.journal.some((line) => line.includes("not spoken:")));
    expect(r.journal.filter((line) => line.includes("not spoken:"))).toHaveLength(1);
    r.blockSay(false);
    r.release();
    end();
    await turn;
  });
});

describe("drive test 7: the conversation is usable after the microphone is cut", () => {
  test("after a cut and an open, the next utterance reaches the agent", async () => {
    const r = bridge();
    r.stt.transcribe = async () => "what time is it";
    // Mic tapped: the phone cuts its track, and no frames arrive while Android Auto has the microphone
    r.channel.receive({ kind: "mic", on: false });
    // Mic tapped again, and Chris speaks
    r.channel.receive({ kind: "mic", on: true });
    r.talk();
    r.hush();
    await until(() => r.agent.calls.some((call) => call.startsWith("ask")));
    expect(r.journal).toEqual(expect.arrayContaining(["[the phone cut its microphone]", "[the phone opened its microphone]"]));
    expect(r.agent.calls.find((call) => call.startsWith("ask"))).toEndWith("\n\nwhat time is it");
  });
});

describe("drive test 13: a phone that arrives while the engines warm gets the words", () => {
  test("it gets the protocol, the settings and the history before the engines are warm, and its cut lands", async () => {
    let warm = () => {};
    const r = bridge({ warm: new Promise<void>((resolve) => { warm = resolve; }) });
    r.stt.transcribe = async () => "are you there";
    r.channel.joined();
    // the End the turn button takes its words from the protocol, so it is enabled at once
    expect(r.told.map((m) => m.kind)).toEqual(["protocol", "starting", "settings", "history"]);
    r.channel.receive({ kind: "mic", on: false });
    expect(r.journal).toContain("[the phone cut its microphone]");
    r.channel.receive({ kind: "mic", on: true });
    warm();
    await r.ready;
    await tick();
    expect(r.told.filter((m) => m.kind === "starting")).toEqual([{ kind: "starting", on: true }, { kind: "starting", on: false }]);
    // the first thing said once the engines are warm is heard
    r.talk();
    r.hush();
    await until(() => r.agent.calls.some((call) => call.startsWith("ask")));
    expect(r.agent.calls.find((call) => call.startsWith("ask"))).toEndWith("\n\nare you there");
  });
});

describe("drive test 15: the agent plays a file and talks about it in the same turn", () => {
  const folder = mkdtempSync(join(tmpdir(), "drive-hold-"));
  writeFileSync(join(folder, "a.wav"), encodeWav(new Int16Array(RATE * 5).fill(1_000), RATE));
  const file = encodeWav(new Int16Array(RATE / 10), RATE);

  test("two tracks asked for during a turn with the hold music on both play whole, then the sentence", async () => {
    let end = () => {};
    const r = bridge({
      script: {
        // a tool call makes the turn long, and only a long turn gets hold music (15.7.5)
        during: (hooks) => { hooks.onBlockStart?.("tool_use"); hooks.onBlockEnd?.(); },
        deltas: ["Those were the two previews."],
        hold: new Promise<void>((resolve) => { end = resolve; }),
      },
      overrides: { holdMusicAfterMs: 20, holdMusicFadeMs: 20, holdMusicFadeInMs: 0 },
      music: { folder, lasts: 600 },
    });
    // the decode is ffmpeg's real time, which the fake clock would run past: do it before the turn
    await r.mouth.music(() => true);
    // one source, as in the room: a track that plays holds it, and another is refused until it ends
    const events = () => r.measures.recent(200).flatMap((e) => (e.kind === "track" ? [e] : []));
    const source = setInterval(() => {
      const on = events().filter((e) => e.on).length;
      const off = events().filter((e) => !e.on).length;
      r.source.taken = on > off;
    }, 1);
    try {
      const turn = r.c.turn("play me the two previews and tell me about them");
      await until(() => events().some((e) => e.what === "music" && e.on));
      expect(events().some((e) => e.what === "music" && e.on)).toBe(true);
      // the agent's two POST /play requests, as the tool call makes them
      r.mouth.play(file);
      r.mouth.play(file);
      await until(() => events().filter((e) => e.what === "file" && !e.on).length === 2, 3_000);
      end();
      await turn;
      await until(() => r.said.includes("Those were the two previews."));
      const files = events().filter((e) => e.what === "file" && !e.on);
      expect(files.map((e) => e.whole)).toEqual([true, true]);
      expect(r.said).toContain("Those were the two previews.");
    } finally {
      clearInterval(source);
    }
  });
});
