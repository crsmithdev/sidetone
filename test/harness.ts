/**
 * One bridge for the tests, assembled the way the car assembles it.
 *
 * Every test file used to build the wiring by hand, and the copies drifted:
 * one wired the mouth's `talking` to a flag of its own, where `assemble` wires
 * it to the ear. So a test could pass with a barge-in that the car would never
 * see. There is one copy now, and it is `assemble` itself: only the engines,
 * the record and the agent are fakes.
 *
 * `speech()` and `hush()` are frames as the phone sends them, so a test that
 * wants Chris talking makes him talk rather than setting a flag.
 */
import { afterEach } from "bun:test";
import { assemble, type Bridge, type Parts } from "../src/bridge.ts";
import { DEFAULTS, type Config } from "../src/config.ts";
import type { Agent, MakeAgent } from "../src/conversation.ts";
import type { Outgoing } from "../src/messages.ts";
import type { Fade, Speaker } from "../src/mouth.ts";
import type { SessionHooks, Turn } from "../src/session.ts";

export const RATE = 16_000;

/** The rate a test's frames arrive at, and the settings every file starts from. */
export const TEST_CONFIG: Config = { ...DEFAULTS, sampleRate: RATE } as Config;

/** What a test may script the agent to do. */
export interface Script {
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

/** The agent, scripted: no Claude Code process anywhere near a turn. */
export function scripted(script: Script = {}) {
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

/** What a test may do to the hold music's source and to a sentence's length. */
export interface Music {
  file: string;
  /** the track ends by itself after this long; unset, it plays until it is cut */
  lasts?: number;
  /** a sentence takes this long to play, as a real one does; unset, it is instant */
  sentenceMs?: number;
}

export interface Options {
  script?: Script;
  overrides?: Partial<Config>;
  music?: Music;
}

const built: Bridge[] = [];
// the assembly keeps two timers, as the car does; a test file stops them here
afterEach(() => { while (built.length) built.pop()?.stop(); });

/**
 * A bridge over fake engines. The speaker keeps what it played and can be
 * blocked mid-sentence, made to report a sentence cut short, or made to refuse
 * a track because something else owns the source.
 */
export function bridge(options: Options = {}) {
  const music = options.music;
  // 15.8 the track the mouth decodes is the one in the settings, as in the car.
  // Without one, the music is off, so no test reaches for the file on this machine.
  const config = {
    ...TEST_CONFIG,
    ...options.overrides,
    ...(music ? { holdMusicFile: music.file } : { holdMusic: false }),
  };
  const said: string[] = [];
  const cues: string[] = [];
  const told: Outgoing[] = [];
  const patches: Array<Partial<Config>> = [];
  const journal: string[] = [];
  const lookahead: Array<string | undefined> = [];
  const switched: string[] = [];
  const tracks: Array<{ stopped: boolean }> = [];
  const source = { taken: false };
  let gate: (() => void) | null = null;
  let blocking = false;
  let whole = true;

  const speaker: Speaker = {
    async play(text) {
      said.push(text);
      if (music?.sentenceMs) await new Promise((resolve) => setTimeout(resolve, music.sentenceMs));
      if (blocking) await new Promise<void>((resolve) => { gate = resolve; });
      return whole;
    },
    cue(wav) { cues.push(wav); },
    // the room's speaker, in miniature: a taken source refuses, and the cut is asked as it plays
    track(_wav: Uint8Array, cut: () => boolean, fade: Fade) {
      if (source.taken) return null;
      const track = { stopped: false };
      tracks.push(track);
      return new Promise<boolean>((resolve) => {
        const started = Date.now();
        let fadedAt = 0;
        const poll = setInterval(() => {
          if (!fadedAt && fade.when()) fadedAt = Date.now();
          if (cut() || (fadedAt && Date.now() - fadedAt >= fade.ms)) { track.stopped = true; clearInterval(poll); resolve(false); }
          else if (music?.lasts !== undefined && Date.now() - started >= music.lasts) { clearInterval(poll); resolve(true); }
        }, 2);
      });
    },
  };

  const agent = scripted(options.script);
  const parts: Parts = {
    stt: { start: async () => {}, warmupSeconds: 1, transcribe: async () => "", stop: () => {} },
    tts: { start: async () => {}, sampleRate: RATE, synthesize: async (_text, wav) => wav, switchable: true, use: () => {}, voice: "test", stop: () => {} },
    made: {
      take: async (text: string) => text,
      start: (text: string | undefined) => { lookahead.push(text); },
      use: (voice: string) => { switched.push(voice); return true; },
    },
    cues: { file: (name) => name, build: async () => {} },
    record: () => {},
    makeAgent: agent.make,
    jobs: () => 0,
    // 9.4 a test never writes the config file the car keeps its settings in
    settings: (patch) => { patches.push(patch); },
    scratch: "/tmp",
  };

  const assembled = assemble("/tmp", config, RATE, speaker, (message) => told.push(message), (line) => journal.push(line), parts);
  built.push(assembled);
  return {
    ...assembled,
    c: assembled.conversation,
    said, cues, told, journal, lookahead, switched, tracks, source, agent, patches,
    /** 14.7 the turns the client was told about, read when a test asks, not when it starts */
    get turns() { return told.filter((message): message is Extract<Outgoing, { kind: "turn" }> => message.kind === "turn"); },
    config,
    blockSay: (on: boolean) => { blocking = on; },
    cutSay: (on: boolean) => { whole = !on; },
    release: () => { gate?.(); gate = null; },
    /** Chris talks: frames loud enough to be speech, for as long as it takes. */
    talk: (ms = 500) => { for (const f of frames(0.4, ms)) assembled.ear.frame(f); },
    /** and stops: quiet frames, which is what ends an utterance. */
    hush: (ms = 1_600) => { for (const f of frames(0.001, ms)) assembled.ear.frame(f); },
  };
}

/** Frames at a level, 20 ms each, as the phone sends them. */
function frames(level: number, ms: number): Int16Array[] {
  const one = new Int16Array(Math.round(RATE * 0.02));
  one.fill(Math.round(level * 32768));
  return Array.from({ length: Math.round(ms / 20) }, () => one);
}
