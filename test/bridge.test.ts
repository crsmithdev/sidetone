/**
 * The bridge as the car runs it, with fake engines (spec 11.3, 11.9).
 *
 * Every other test here builds the wiring by hand, and the copies drifted: one
 * wires the mouth's `talking` to a flag on its own fake source, where
 * `assemble` wires it to the ear. So the one loop that decides a barge-in —
 * frames reach the ear, the ear stops the speech, the mouth holds the rest —
 * had no test at all. This drives it through the real objects.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { assemble, type Parts } from "../src/bridge.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import type { Agent, MakeAgent } from "../src/conversation.ts";
import type { Outgoing } from "../src/messages.ts";
import type { Speaker } from "../src/mouth.ts";
import type { SessionHooks, Turn } from "../src/session.ts";

const RATE = 16_000;

// a barge-in waits `interruptAfterMs` for the turn to end by itself; a test does not
const config: Config = { ...DEFAULTS, audioCueDelayMs: 10, audioCueEveryMs: 10, interruptAfterMs: 20, graceMs: 20 };

/** A frame at a level, as the phone would send it. */
function frame(level: number, ms = 20): Int16Array {
  const samples = new Int16Array(Math.round((RATE * ms) / 1000));
  samples.fill(Math.round(level * 32768));
  return samples;
}

const speech = (frames: number) => Array.from({ length: frames }, () => frame(0.4));
const quiet = (frames: number) => Array.from({ length: frames }, () => frame(0.001));

/** The agent, scripted: it answers with the deltas it was given. */
function scripted(deltas: string[]): { make: MakeAgent } {
  let hooks: SessionHooks = {};
  const agent: Agent = {
    start: () => {},
    stop: () => {},
    async ask(): Promise<Turn> {
      for (const delta of deltas) hooks.onDelta?.(delta);
      return { number: 1, text: deltas.join(""), costUsd: 0, isError: false };
    },
    agree: () => {},
    interrupt: () => {},
    restart: () => {},
    running: true,
    turns: 1,
    rateLimit: { fiveHour: 0, sevenDay: 0 },
    contextFraction: () => null,
    totalCostUsd: () => 0,
  };
  return { make: (given) => { hooks = given; return agent; } };
}

/**
 * The bridge with fakes at the two ends that cost seconds and a graphics card:
 * the engines, the record and the agent. Everything between them is the real
 * wiring the car runs.
 */
function bridge(options: { deltas?: string[]; said?: string[]; heard?: string; sentenceMs?: number } = {}) {
  const said = options.said ?? [];
  const told: Outgoing[] = [];
  const speaker: Speaker = {
    async play(text) {
      said.push(text);
      if (options.sentenceMs) await new Promise((resolve) => setTimeout(resolve, options.sentenceMs));
      return true;
    },
    cue() {},
    track() { return null; },
  };
  const parts: Parts = {
    stt: { start: async () => {}, warmupSeconds: 1, transcribe: async () => options.heard ?? "", stop: () => {} },
    tts: { start: async () => {}, sampleRate: RATE, synthesize: async (_text, wav) => wav, switchable: true, use: () => {}, voice: "test", stop: () => {} },
    made: { take: async (text: string) => text, start: () => {}, use: () => true },
    cues: { file: (name) => name, build: async () => {} },
    record: () => {},
    makeAgent: scripted(options.deltas ?? []).make,
    jobs: () => 0,
    scratch: mkdtempSync(`${tmpdir()}/sidetone-test-`),
  };
  return { ...assemble("/tmp", config, RATE, speaker, (message) => told.push(message), () => {}, parts), said, told };
}

describe("the bridge, assembled as the car runs it", () => {
  test("the engines are the ones it was given, and the health check reads them", async () => {
    const b = bridge();
    await b.ready;
    expect(b.stt.warmupSeconds).toBeGreaterThan(0);
    expect(b.tts.sampleRate).toBe(RATE);
    b.stop();
  });

  test("Chris speaking over the answer holds the rest of it (11.3, 11.9)", async () => {
    const b = bridge({ deltas: ["One. ", "Two. ", "Three. "], sentenceMs: 30, heard: "never mind" });
    const turn = b.conversation.turn("say three sentences");
    // let the first sentence reach the speaker, then talk over it
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const f of speech(25)) b.ear.frame(f);
    expect(b.ear.bargingIn).toBe(true);
    expect(b.mouth.onHold).toBe(true);
    // the ear's word is what the mouth reads: no flag of a test's own
    for (const f of quiet(90)) b.ear.frame(f);
    await turn;
    b.stop();
  });
});
