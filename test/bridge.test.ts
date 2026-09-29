/**
 * The loops that only exist in `assemble` (spec 11.3, 11.9, 14.11, 9.4).
 *
 * Each of these runs through two modules that the other test files drive one
 * at a time: the ear and the mouth, the channel and the ear, a command and the
 * settings the car keeps. They are the ones a drive exercises every minute and
 * no test reached, because the wiring they need was made inside `assemble`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeWav } from "../src/audio.ts";
import { HANDOFF, PICKUP, STARTED } from "../src/bridge.ts";
import { DEFAULTS } from "../src/config.ts";
import { SentClips } from "../src/sent.ts";
import type { TurnDetector } from "../src/speech.ts";
import { fakeClock, finish, pass, settle, until } from "./clock.ts";
import { bridge } from "./harness.ts";

fakeClock();
const tick = settle;

describe("the bridge, assembled as the car assembles it", () => {
  test("the engines are the ones it was given, and the health check reads them", async () => {
    const r = bridge();
    await r.ready;
    expect(r.stt.warmupSeconds).toBeGreaterThan(0);
    expect(r.tts.sampleRate).toBeGreaterThan(0);
  });

  test("14.16 a client that joins while the engines warm is told the bridge starts, then that it is ready", async () => {
    let warm = () => {};
    const r = bridge({ warm: new Promise<void>((resolve) => { warm = resolve; }) });
    r.channel.joined();
    await tick();
    expect(r.told.filter((m) => m.kind === "starting")).toEqual([{ kind: "starting", on: true }]);
    warm();
    await r.ready;
    await tick();
    expect(r.told.filter((m) => m.kind === "starting")).toEqual([{ kind: "starting", on: true }, { kind: "starting", on: false }]);
  });

  test("14.16.4 a new bridge says it started once, when it is warm and a client is in the room", async () => {
    let warm = () => {};
    const r = bridge({ warm: new Promise<void>((resolve) => { warm = resolve; }) });
    r.channel.joined();
    await tick();
    // cold: nothing is said while the engines load
    expect(r.told.filter((m) => m.kind === "narration")).toEqual([]);
    warm();
    await r.ready;
    await until(() => r.said.length > 0, 2_000);
    expect(r.said).toEqual([STARTED]);
    expect(r.told).toContainEqual({ kind: "narration", text: STARTED, announce: true });
    // a rejoin of the same process is not a start
    r.channel.joined();
    await pass(600);
    expect(r.said).toEqual([STARTED]);
  });

  test("14.16.4 a warm bridge with nobody in the room says it started when a client joins", async () => {
    const r = bridge();
    await r.ready;
    await pass(600);
    expect(r.said).toEqual([]);
    r.channel.joined();
    await until(() => r.said.length > 0, 2_000);
    expect(r.said).toEqual([STARTED]);
  });

  test("Chris speaking over the answer holds the rest of it (11.3, 11.9)", async () => {
    const r = bridge({ script: { deltas: ["One. ", "Two. ", "Three. "] }, overrides: { graceMs: 20 } });
    const turn = r.c.turn("say three sentences");
    await tick();
    // the mouth reads the ear, not a flag of this test's own
    r.talk();
    expect(r.ear.bargingIn).toBe(true);
    expect(r.mouth.onHold).toBe(true);
    r.hush();
    await turn;
  });

  test("road noise that carried no words lets the answer go on (11.7)", async () => {
    const r = bridge({ script: { deltas: ["One. ", "Two. "] } });
    const turn = r.c.turn("say two sentences");
    await tick();
    r.talk();
    expect(r.mouth.onHold).toBe(true);
    // the engine finds nothing in it, which is a lorry and not a barge-in
    r.hush();
    await turn;
    await tick();
    expect(r.mouth.onHold).toBe(false);
  });

  test("a microphone cut ends the utterance, and an open one does not (ADR 0008)", () => {
    const r = bridge();
    r.talk();
    expect(r.ear.bargingIn).toBe(true);
    r.channel.receive({ kind: "mic", on: false, release: true });
    // the cut dropped the half recording, so nothing is being said any more
    expect(r.ear.bargingIn).toBe(false);
    expect(r.journal.some((line) => line.includes("cut its microphone"))).toBe(true);
  });

  test("a pause while the hold to talk button is down does not end the turn; the release does (9.5.2)", async () => {
    const r = bridge();
    // the engine names what it hears by its level, so the words say which side of the pause they came from
    r.stt.transcribe = async (wav) => {
      const { samples } = decodeWav(new Uint8Array(await Bun.file(wav).arrayBuffer()));
      const words: string[] = [];
      for (let at = 0; at < samples.length; at += 320) {
        const word = samples[at]! > 12_000 ? "open" : samples[at]! > 8_000 ? "the garage" : null;
        if (word && words.at(-1) !== word) words.push(word);
      }
      return words.join(" ");
    };
    const say = (level: number, ms: number) => { for (let i = 0; i < ms / 20; i++) r.ear.frame(new Int16Array(320).fill(Math.round(level * 32768))); };
    r.channel.receive({ kind: "mic", on: true, hold: true });
    say(0.4, 500);
    // longer than the end-of-turn pause, with the button still down
    say(0.001, r.config.endOfTurnPauseMs + 500);
    say(0.3, 500);
    r.channel.receive({ kind: "mic", on: false, release: true });
    await until(() => r.agent.calls.some((call) => call.startsWith("ask")));
    const asked = r.agent.calls.filter((call) => call.startsWith("ask"));
    expect(asked).toHaveLength(1);
    expect(asked[0]).toEndWith("\n\nopen the garage");
  });

  test("what the phone says it hears reaches the reading both ends keep (N.1)", () => {
    const r = bridge();
    r.channel.receive({ kind: "quality", quality: "excellent" });
    expect(r.c.network.get("phone")).toBe("excellent");
  });

  test("a setting said out loud changes the live copy, is kept, and is recorded (9.4)", async () => {
    const r = bridge();
    expect(r.config.holdMusic).toBe(false);
    await r.c.heard("sidetone music on");
    // the live copy is what /diagnostics reports, the patch is what the next run reads
    expect(r.config.holdMusic).toBe(true);
    expect(r.patches).toEqual([{ holdMusic: true }]);
    expect(r.measures.recent().some((event) => event.kind === "setting")).toBe(true);
  });

  test("an announcement says the line and shows it, as one thing (17.17)", async () => {
    const r = bridge();
    r.announce("Job research finished.");
    // the app has the words at once; the voice waits until nothing is running
    expect(r.told).toContainEqual({ kind: "narration", text: "Job research finished.", announce: true });
    await until(() => r.said.length > 0, 2_000);
    expect(r.said).toEqual(["Job research finished."]);
  });

  test("job news waits for a running turn, then goes in as one turn (14.10.6)", async () => {
    let release!: () => void;
    const r = bridge({ script: { hold: new Promise<void>((resolve) => { release = resolve; }) } });
    void r.c.turn("what is going on");
    r.tell("sidetone/alpha passed");
    r.tell("cloudchamber/beta needs-you question");
    const asks = () => r.agent.calls.filter((call) => call.startsWith("ask "));
    expect(asks().length).toBe(1);
    release();
    await until(() => asks().length === 2, 3_000);
    expect(asks()[1].endsWith("[job news] sidetone/alpha passed\n[job news] cloudchamber/beta needs-you question")).toBe(true);
  });

  test("job news waits while Chris talks, and his question is not refused (14.10.6, 11.9)", async () => {
    const r = bridge();
    let read!: () => void;
    const reading = new Promise<void>((resolve) => { read = resolve; });
    r.stt.transcribe = async () => { await reading; return "what time is it"; };
    const asks = () => r.agent.calls.filter((call) => call.startsWith("ask "));
    r.talk();
    r.tell("sidetone/alpha passed");
    r.announce("Job research finished.");
    r.hush();
    // the utterance has ended and is still being read; a tick of the news clock passes
    await pass(1_100);
    expect(asks()).toHaveLength(0);
    expect(r.said).toEqual([]);
    read();
    await until(() => asks().length === 2, 3_000);
    expect(asks()[0]).toEndWith("what time is it");
    expect(asks()[1]).toEndWith("[job news] sidetone/alpha passed");
    expect(r.said.some((line) => line.startsWith("I am still on the last one"))).toBe(false);
    await until(() => r.said.includes("Job research finished."), 2_000);
  });

  describe("the notifications level on job news (item 76)", () => {
    const asks = (r: ReturnType<typeof bridge>) => r.agent.calls.filter((call) => call.startsWith("ask "));

    test("full gives the agent each line as aleph sent it", async () => {
      const r = bridge({ overrides: { notifications: "full" } });
      r.tell("sidetone/alpha needs-you which branch?");
      await until(() => asks(r).length === 1, 3_000);
      expect(asks(r)[0]).toEndWith("[job news] sidetone/alpha needs-you which branch?");
    });

    test("brief gives the agent only that a job finished, and says to say only that", async () => {
      const r = bridge({ overrides: { notifications: "brief" } });
      r.tell("sidetone/alpha landed; check open");
      await until(() => asks(r).length === 1, 3_000);
      expect(asks(r)[0]).toContain("notifications are brief");
      expect(asks(r)[0]).toEndWith("[job news] sidetone/alpha finished");
    });

    test("brief holds back a question, and off holds back everything", async () => {
      for (const [level, line] of [["brief", "sidetone/alpha needs-you which branch?"], ["off", "sidetone/alpha failed"]] as const) {
        const r = bridge({ overrides: { notifications: level } });
        r.tell(line);
        await pass(1_100);
        expect(asks(r)).toHaveLength(0);
        expect(r.journal.some((entry) => entry.includes(`as notifications are ${level}`))).toBe(true);
      }
    });

    test("a client sets it, with no answer, and the answer verbosity stays", async () => {
      const r = bridge();
      r.channel.receive({ kind: "setting", patch: { notifications: "off" } });
      expect(r.patches).toEqual([{ notifications: "off" }]);
      expect(r.config.verbosity).toBe("normal");
      r.channel.receive({ kind: "setting", patch: { notifications: "loud" } });
      expect(r.patches).toEqual([{ notifications: "off" }]);
      await pass(600);
      expect(r.said).toEqual([]);
    });
  });

  test("a setting a client sends does what the spoken command does (9.4.9)", async () => {
    const r = bridge();
    r.channel.receive({ kind: "setting", patch: { holdMusic: true } });
    await until(() => r.said.length > 0);
    // the same reply, the same patch, the same record: tapping cannot outrun talking
    expect(r.said).toEqual(["Music on."]);
    expect(r.patches).toEqual([{ holdMusic: true }]);
    expect(r.config.holdMusic).toBe(true);
    // and every client is told what is in force now
    const settings = r.told.filter((message) => message.kind === "settings");
    expect(settings.length).toBeGreaterThan(0);
    expect((settings.at(-1) as { settings: Record<string, unknown> }).settings.holdMusic).toBe(true);
  });

  test("a setting a client may not reach is ignored (9.4.9)", async () => {
    const r = bridge();
    r.channel.receive({ kind: "setting", patch: { sttModel: "tiny.en", recordPath: "/etc/passwd" } });
    await pass(10);
    expect(r.patches).toEqual([]);
    expect(r.said).toEqual([]);
  });

  test("a threshold a client sends is what the ear judges the next utterance by (item 44)", async () => {
    const r = bridge();
    const loud = new Int16Array(320).fill(Math.round(0.4 * 32768));
    const quiet = new Int16Array(320);
    // a peak of 0.4 is speech at the default of 0.15, and too quiet at 0.5
    r.channel.receive({ kind: "setting", patch: { minSpeechPeak: 0.5 } });
    for (let i = 0; i < 20; i++) r.ear.frame(loud);
    for (let i = 0; i < 100; i++) r.ear.frame(quiet);
    await until(() => r.journal.some((line) => line.includes("too quiet")));
    expect(r.journal.some((line) => line.includes("too quiet: peak 0.40, under 0.5"))).toBe(true);
    expect(r.config.minSpeechPeak).toBe(0.5);
  });

  test("the bridge hearing its own voice goes in the record (18.10)", async () => {
    const r = bridge({ script: { deltas: ["The service restarted about nine minutes ago. "] } });
    await r.c.turn("when did it restart");
    // the phone's echo canceller let the speaker through, which is the volume slider of 21 September
    await r.c.heard("the service restarted about nine minutes ago");
    const echoes = r.measures.recent().flatMap((event) => (event.kind === "echo" ? [event] : []));
    expect(echoes).toHaveLength(1);
    expect(echoes[0]?.spoke).toBe("The service restarted about nine minutes ago.");
    expect(r.journal.some((line) => line.includes("may have heard itself"))).toBe(true);
    // it is recorded, not acted on: the words still reach the agent
    expect(r.agent.calls.some((call) => call.endsWith("\n\nthe service restarted about nine minutes ago"))).toBe(true);
  });

  test("audio off said over an answer goes quiet after its acknowledgement (11.12.2)", async () => {
    const r = bridge();
    r.c.ears.stopSpeaking();
    r.mouth.say("One."); r.mouth.say("Two."); r.mouth.say("Three.");
    await r.c.heard("sidetone audio off");
    await until(() => r.said.length === 4);
    // the rest of the answer goes on as words, and none of it as a voice
    expect(r.said).toEqual(["Audio off.", "One.", "Two.", "Three."]);
    expect(r.voiced).toEqual(["Audio off."]);
    expect(r.mouth.audioOn).toBe(false);
  });

  test("what Chris actually says is not taken for an echo (18.10)", async () => {
    const r = bridge({ script: { deltas: ["The service restarted about nine minutes ago. "] } });
    await r.c.turn("when did it restart");
    await r.c.heard("why did it restart in the first place");
    expect(r.measures.recent().filter((event) => event.kind === "echo")).toEqual([]);
  });

  test("the audio can be turned on again by voice, from the car (11.12)", async () => {
    const r = bridge();
    await r.c.heard("sidetone audio off");
    await until(() => r.said.length > 0);
    // it says so before it goes quiet, so the last thing heard says why
    expect(r.said).toEqual(["Audio off."]);
    await until(() => !r.mouth.audioOn);
    expect(r.mouth.audioOn).toBe(false);
    // and the way back is something that can be said: the ear never stopped
    await r.c.heard("sidetone audio on");
    await until(() => r.mouth.audioOn);
    expect(r.mouth.audioOn).toBe(true);
    // every client is told, because the app's own button has to read it back
    const settings = r.told.flatMap((message) => (message.kind === "settings" ? [message.settings] : []));
    expect(settings.at(-1)?.audio).toBe(true);
  });

  test("the audio button is kept across restarts, and every client reads it back (11.12.3)", async () => {
    const r = bridge();
    r.channel.receive({ kind: "voice", on: false });
    expect(r.mouth.audioOn).toBe(false);
    expect(r.patches).toEqual([{ audio: false }]);
    const settings = r.told.flatMap((message) => (message.kind === "settings" ? [message.settings] : []));
    expect(settings.at(-1)?.audio).toBe(false);
    // the next process starts from the file, not with the audio on
    expect(bridge({ overrides: { audio: false } }).mouth.audioOn).toBe(false);
  });

  test("the hold music delay from the options screen is kept, read back, and not answered (15.7.6)", async () => {
    const r = bridge();
    r.channel.receive({ kind: "setting", patch: { holdMusicAfterMs: 5_000 } });
    expect(r.patches).toEqual([{ holdMusicAfterMs: 5_000 }]);
    expect(r.config.holdMusicAfterMs).toBe(5_000);
    const settings = r.told.flatMap((message) => (message.kind === "settings" ? [message.settings] : []));
    expect(settings.at(-1)?.holdMusicAfterMs).toBe(5_000);
    // zero is the music off, which is the music button's, and a word is not a time
    r.channel.receive({ kind: "setting", patch: { holdMusicAfterMs: 0 } });
    r.channel.receive({ kind: "setting", patch: { holdMusicAfterMs: -3_000 } });
    r.channel.receive({ kind: "setting", patch: { holdMusicAfterMs: "longer" } });
    await until(() => true);
    expect(r.patches).toEqual([{ holdMusicAfterMs: 5_000 }]);
    expect(r.said).toEqual([]);
  });

  test("what Chris says arrives through the channel as a turn (14.11)", async () => {
    const r = bridge({ script: { deltas: ["Four."] } });
    r.channel.receive({ kind: "said", text: "what is two plus two" });
    await until(() => r.said.length > 0);
    expect(r.agent.calls.some((call) => call.endsWith("\n\nwhat is two plus two"))).toBe(true);
    expect(r.said).toEqual(["Four."]);
  });
});

/** 18.15 the bridge changes the phone's audio setup without a build. */
describe("a pushed audio setup (18.15)", () => {
  const names = { mode: "normal", output: "media", focus: "none", canceller: "software", noiseSuppression: true, autoGainControl: false } as const;

  test("a push reaches the phone, the journal and the record, as one thing", () => {
    const r = bridge();
    r.setup({ kind: "setup", default: false, ...names });
    expect(r.told).toContainEqual({ kind: "setup", default: false, ...names });
    expect(r.journal.at(-1)).toBe("[pushed the phone an audio setup: normal mode, media output, no focus, software canceller, noise suppression on, auto gain control off; the phone rejoins with it]");
    expect(r.measures.recent().at(-1)).toMatchObject({ kind: "setup", pushed: names });
  });

  test("a default sends the phone back to the setup in its code, and the record says so", () => {
    const r = bridge();
    r.setup({ kind: "setup", default: true });
    expect(r.told).toContainEqual({ kind: "setup", default: true });
    expect(r.journal.at(-1)).toBe("[pushed the phone the setup in the app's code; the phone rejoins with it]");
    expect(r.measures.recent().at(-1)).toMatchObject({ kind: "setup", pushed: null });
  });
});

/** 18.16 the turn detector in shadow: loaded, it writes a guess; not loaded, it says so once and is off. */
describe("the turn detector in shadow (18.16)", () => {
  const scores = (probability: number): TurnDetector => ({ start: async () => {}, loadSeconds: 0.4, score: async () => ({ probability, inferenceMs: 12 }), stop: () => {} });

  test("once it has loaded, a tentative end is a guess in the record", async () => {
    const r = bridge({ turn: scores(0.9) });
    await tick();
    expect(r.journal).toContain("[turn detector in shadow, loaded in 0.4s]");
    r.talk();
    r.hush();
    await until(() => r.measures.recent().some((event) => event.kind === "turnGuess"));
    expect(r.measures.recent().find((event) => event.kind === "turnGuess")).toMatchObject({ probability: 0.9, outcome: "ended", endedBy: "pause" });
  });

  test("a worker that does not load is one line, and the ear goes on without it", async () => {
    const broken: TurnDetector = { ...scores(0.9), start: async () => { throw new Error("no model at /nowhere"); } };
    const r = bridge({ turn: broken });
    await tick();
    r.talk();
    r.hush();
    await tick();
    expect(r.journal.filter((line) => line.startsWith("[turn detector"))).toEqual(["[turn detector off: it did not load: no model at /nowhere]"]);
    expect(r.measures.recent().some((event) => event.kind === "turnGuess")).toBe(false);
    expect(r.measures.recent().some((event) => event.kind === "heard")).toBe(true);
  });

  test("off starts no worker", async () => {
    let started = 0;
    const r = bridge({ turn: { ...scores(0.9), start: async () => { started++; } }, overrides: { turnDetector: "off" } });
    await tick();
    expect(started).toBe(0);
    expect(r.journal.some((line) => line.startsWith("[turn detector"))).toBe(false);
  });
});

describe("the utterances the bridge heard (18.14.4)", () => {
  /** One utterance, loud enough to be speech, then the end-of-turn pause. */
  async function speak(r: ReturnType<typeof bridge>) {
    r.stt.transcribe = async () => "sidetone, end turn";
    const say = (level: number, ms: number) => { for (let i = 0; i < ms / 20; i++) r.ear.frame(new Int16Array(320).fill(Math.round(level * 32768))); };
    say(0.4, 500);
    say(0.001, r.config.endOfTurnPauseMs + 500);
    await until(() => r.journal.some((line) => line.includes("sidetone, end turn")));
  }

  test("the setting is off, because the copy is Chris's voice", () => {
    expect(DEFAULTS.keepHeardClips).toBe(false);
    expect(DEFAULTS.heardDir.endsWith(join(".sidetone", "heard"))).toBe(true);
  });

  test("off, nothing is kept", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heard-"));
    await speak(bridge({ overrides: { heardDir: dir } }));
    expect(new SentClips(dir).list()).toEqual([]);
  });

  test("on, each utterance is kept with what the engine wrote for it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heard-"));
    await speak(bridge({ overrides: { keepHeardClips: true, heardDir: dir } }));
    const kept = new SentClips(dir).list();
    expect(kept.length).toBeGreaterThan(0);
    expect(kept.every((clip) => clip.text === "sidetone, end turn" && clip.source === "heard")).toBe(true);
    expect(decodeWav(await Bun.file(kept[0]!.wav).bytes()).samples.length).toBeGreaterThan(0);
  });

  test("off, the card of test 17 keeps them while it runs (item 65)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heard-"));
    const r = bridge({ overrides: { heardDir: dir } });
    await r.c.heard("sidetone, read the card");
    await speak(r);
    expect(new SentClips(dir).list().map((clip) => clip.text)).toContain("sidetone, end turn");
  });

  test("a copy that fails costs a journal line, not the words", async () => {
    // a file where the folder should be, so the copy cannot be made
    const file = join(mkdtempSync(join(tmpdir(), "heard-")), "not-a-folder");
    await Bun.write(file, "");
    const r = bridge({ overrides: { keepHeardClips: true, heardDir: file } });
    await speak(r);
    expect(r.journal.some((line) => line.includes("could not keep the utterance"))).toBe(true);
  });
});

describe("item 72 the context outlives a restart", () => {
  test("a stop sends the handoff as a quiet turn and waits for its result", async () => {
    let answer = () => {};
    const r = bridge({ script: { deltas: ["Handoff saved to ~/.aleph/handoffs/sidetone.md."], hold: new Promise<void>((resolve) => { answer = resolve; }) } });
    await r.ready;
    let done = null as boolean | null;
    void r.handoff(10_000).then((value) => { done = value; });
    await pass(500);
    expect(r.agent.calls).toContain(`ask ${HANDOFF}`);
    // it waits for the result
    expect(done).toBeNull();
    answer();
    await until(() => done !== null);
    expect(done).toBe(true);
    // Chris hears none of it, and the screen shows none of it
    await pass(200);
    expect(r.said).toEqual([]);
    expect(r.told.filter((m) => m.kind === "delta" || m.kind === "turn")).toEqual([]);
  });

  test("a handoff that runs over gives up at the time it was given", async () => {
    const r = bridge({ script: { hold: new Promise<void>(() => {}) } });
    await r.ready;
    expect(await finish(r.handoff(1_000), 2_000)).toBe(false);
    expect(r.agent.calls).toContain(`ask ${HANDOFF}`);
  });

  test("with keepContext off a stop asks for no handoff", async () => {
    const r = bridge({ overrides: { keepContext: false } });
    await r.ready;
    expect(await r.handoff(1_000)).toBe(false);
    expect(r.agent.calls.filter((call) => call.startsWith("ask"))).toEqual([]);
  });

  test("a turn that runs at the stop is interrupted, and the handoff follows it", async () => {
    let release = () => {};
    const r = bridge({ script: { hold: new Promise<void>((resolve) => { release = resolve; }), onInterrupt: () => release() } });
    await r.ready;
    void r.c.turn("restart the service");
    await settle();
    expect(await finish(r.handoff(10_000))).toBe(true);
    const calls = r.agent.calls.filter((call) => call !== "start");
    expect(calls[0]).toEndWith("restart the service");
    expect(calls.slice(1)).toEqual(["interrupt", `ask ${HANDOFF}`]);
  });

  test("a start picks up the handoff when the last stop left one", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sidetone-handoff-")), "sidetone.md");
    writeFileSync(file, "# Handoff\n");
    const r = bridge({ handoffFile: file, script: { deltas: ["Picking up where we left off."] } });
    await r.ready;
    await pass(200);
    expect(r.agent.calls).toContain(`ask ${PICKUP}`);
    expect(r.said).toEqual([]);
  });

  test("a start with no handoff, as after a crash, sends no pickup", async () => {
    const r = bridge();
    await r.ready;
    await pass(200);
    expect(r.agent.calls.filter((call) => call.startsWith("ask"))).toEqual([]);
  });

  test("with keepContext off a start sends no pickup, even with a handoff there", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sidetone-handoff-")), "sidetone.md");
    writeFileSync(file, "# Handoff\n");
    const r = bridge({ handoffFile: file, overrides: { keepContext: false } });
    await r.ready;
    await pass(200);
    expect(r.agent.calls.filter((call) => call.startsWith("ask"))).toEqual([]);
  });

  test("a turn Chris asks for during the pickup waits for it", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "sidetone-handoff-")), "sidetone.md");
    writeFileSync(file, "# Handoff\n");
    let answer = () => {};
    const r = bridge({ handoffFile: file, script: { hold: new Promise<void>((resolve) => { answer = resolve; }) } });
    await r.ready;
    void r.c.turn("what were we doing");
    await pass(200);
    expect(r.agent.calls.filter((call) => call.startsWith("ask"))).toEqual([`ask ${PICKUP}`]);
    answer();
    await until(() => r.agent.calls.some((call) => call.endsWith("what were we doing")));
    expect(r.agent.calls.filter((call) => call.startsWith("ask")).length).toBe(2);
  });
});
