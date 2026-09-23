/**
 * The loops that only exist in `assemble` (spec 11.3, 11.9, 14.11, 9.4).
 *
 * Each of these runs through two modules that the other test files drive one
 * at a time: the ear and the mouth, the channel and the ear, a command and the
 * settings the car keeps. They are the ones a drive exercises every minute and
 * no test reached, because the wiring they need was made inside `assemble`.
 */
import { describe, expect, test } from "bun:test";
import { bridge } from "./harness.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The turn a client asks for is nobody's promise here, so the test waits for it. */
async function until(done: () => boolean, ms = 1_000): Promise<void> {
  const stop = Date.now() + ms;
  while (!done() && Date.now() < stop) await Bun.sleep(2);
}

describe("the bridge, assembled as the car assembles it", () => {
  test("the engines are the ones it was given, and the health check reads them", async () => {
    const r = bridge();
    await r.ready;
    expect(r.stt.warmupSeconds).toBeGreaterThan(0);
    expect(r.tts.sampleRate).toBeGreaterThan(0);
  });

  test("Chris speaking over the answer holds the rest of it (11.3, 11.9)", async () => {
    const r = bridge({ script: { deltas: ["One. ", "Two. ", "Three. "] }, overrides: { interruptAfterMs: 20, graceMs: 20 } });
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
    const r = bridge({ script: { deltas: ["One. ", "Two. "] }, overrides: { interruptAfterMs: 20 } });
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

  test("the audio off reaches the mouth, and the words carry on (11.12)", () => {
    const r = bridge();
    expect(r.mouth.audioOn).toBe(true);
    r.channel.receive({ kind: "voice", on: false });
    expect(r.mouth.audioOn).toBe(false);
    r.channel.receive({ kind: "voice", on: true });
    expect(r.mouth.audioOn).toBe(true);
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
    await Bun.sleep(10);
    expect(r.patches).toEqual([]);
    expect(r.said).toEqual([]);
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

  test("what Chris says arrives through the channel as a turn (14.11)", async () => {
    const r = bridge({ script: { deltas: ["Four."] } });
    r.channel.receive({ kind: "said", text: "what is two plus two" });
    await until(() => r.said.length > 0);
    expect(r.agent.calls.some((call) => call.endsWith("\n\nwhat is two plus two"))).toBe(true);
    expect(r.said).toEqual(["Four."]);
  });
});
