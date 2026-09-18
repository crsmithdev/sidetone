import { describe, expect, test } from "bun:test";
import { DEFAULTS, type Config } from "../src/config.ts";
import { Conversation } from "../src/conversation.ts";

const config: Config = { ...DEFAULTS, historyMaxAgeMs: 60_000 };
const silent = { say: async () => true, cue: () => {}, tell: () => {} };
const engines = { start: async () => {}, transcribe: async () => "", synthesize: async () => "", stop: () => {} };

function withTranscript(entries: Array<Record<string, unknown>>): Conversation {
  const c = new Conversation("/tmp", config, silent, engines as never);
  (c as unknown as { transcript: Array<Record<string, unknown>> }).transcript.push(...entries);
  return c;
}

describe("what a client missed (14.8)", () => {
  test("a drop in a tunnel is minutes, so recent turns come back", () => {
    const now = 1_000_000;
    const c = withTranscript([{ kind: "turn", text: "recent", at: now - 30_000 }]);
    expect(c.missed(now).map((e) => e.text)).toEqual(["recent"]);
  });
  test("an exchange from hours ago is not something this client missed", () => {
    const now = 1_000_000;
    const c = withTranscript([
      { kind: "turn", text: "hours ago", at: now - 7_200_000 },
      { kind: "turn", text: "just now", at: now - 5_000 },
    ]);
    // replaying the old one arrives looking like the conversation in progress
    expect(c.missed(now).map((e) => e.text)).toEqual(["just now"]);
  });
});

/** A mouth that keeps what it was asked to do, so a command can be checked. */
function watched() {
  const said: string[] = [];
  const cues: string[] = [];
  const mouth = { say: async (text: string) => { said.push(text); return true; }, cue: (name: string) => { cues.push(name); }, tell: () => {} };
  const c = new Conversation("/tmp", config, mouth as never, engines as never);
  return { c, said, cues };
}

/** The speech queue is a promise chain, so a command's reply lands a tick later. */
async function settled(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("the tones (15.4)", () => {
  test("they start on, and one command silences every one of them", async () => {
    const { c, cues } = watched();
    c.cue("thinking");
    expect(cues).toEqual(["thinking"]);
    await c.heard("hey bridge tones off");
    expect(c.tonesOn).toBe(false);
    c.cue("thinking");
    c.cue("heard");
    expect(cues).toEqual(["thinking"]);
  });
  test("the bare word toggles, so it can be said twice while driving", async () => {
    const { c } = watched();
    await c.heard("hey bridge tones");
    expect(c.tonesOn).toBe(false);
    await c.heard("hey bridge tones");
    expect(c.tonesOn).toBe(true);
  });
  test("the explicit form does not flip what is already right", async () => {
    const { c } = watched();
    await c.heard("hey bridge tones off");
    await c.heard("hey bridge tones off");
    expect(c.tonesOn).toBe(false);
  });
  test("turning them off is still answered out loud (15.1)", async () => {
    const { c, said } = watched();
    await c.heard("hey bridge tones off");
    await settled();
    expect(said).toEqual(["Tones off."]);
  });
});

describe("the stats command (18.4)", () => {
  test("it speaks the measurement, not a guess", async () => {
    const { c, said } = watched();
    c.measures.speechEnded(1_000, 2_500);
    c.measures.transcribed(2_800);
    c.measures.answering(3_400);
    await c.heard("hey bridge stats");
    await settled();
    expect(said).toEqual([
      "Last answer, 2.4 seconds. 1.5 of it was the end of turn pause.",
      "Nothing has reported on the connection yet.",
    ]);
  });
  test("it reports the connection in the same breath (N.2.5)", async () => {
    const { c, said } = watched();
    const now = Date.now();
    c.network.saw("phone", "poor", now);
    c.network.saw("bridge", "excellent", now);
    await c.heard("hey bridge stats");
    await settled();
    expect(said.at(-1)).toBe("The phone's connection is poor and this end is excellent.");
  });
  test("with nothing measured it says so", async () => {
    const { c, said } = watched();
    await c.heard("hey bridge latency");
    await settled();
    expect(said).toEqual([
      "No round trip has been measured yet.",
      "Nothing has reported on the connection yet.",
    ]);
  });
});

/**
 * A room with a mouth that can be made to block mid-sentence and to report a
 * sentence cut short, which is what a barge-in looks like from up here.
 */
function room(overrides: Partial<Config> = {}) {
  const said: string[] = [];
  const cues: string[] = [];
  let gate: (() => void) | null = null;
  let blocking = false;
  let whole = true;
  const lookahead: Array<string | undefined> = [];
  const mouth = {
    say: async (text: string, next?: () => string | undefined) => {
      said.push(text);
      // A real mouth makes the sentence before it asks, and the asking is the
      // point: by then the agent has streamed more of its reply. Yielding once
      // is the smallest version of that delay.
      await Promise.resolve();
      lookahead.push(next?.());
      if (blocking) await new Promise<void>((resolve) => { gate = resolve; });
      return whole;
    },
    cue: (name: string) => { cues.push(name); },
    tell: () => {},
  };
  const c = new Conversation("/tmp", { ...config, ...overrides }, mouth as never, engines as never);
  return {
    c, said, cues, lookahead,
    guts: c as unknown as {
      speak(text: string): void;
      turnRunning: boolean;
      said: string[];
      lastReply: string;
      recent: Array<{ said: string; reply: string }>;
    },
    blockSay: (on: boolean) => { blocking = on; },
    cutSay: (on: boolean) => { whole = !on; },
    release: () => { gate?.(); gate = null; },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the hold (11.3)", () => {
  test("a barge-in keeps what is left, and a resume says it", async () => {
    const r = room();
    r.c.stopSpeaking();
    r.guts.speak("one."); r.guts.speak("two.");
    await tick();
    expect(r.said).toEqual([]);
    expect(r.c.onHold).toBe(true);
    r.c.resumeHold();
    await tick();
    expect(r.said).toEqual(["one.", "two."]);
  });

  test("a sentence the barge-in cut is said again from the start", async () => {
    const r = room();
    r.blockSay(true);
    r.guts.speak("first."); r.guts.speak("second.");
    await tick();
    expect(r.said).toEqual(["first."]);
    // Chris starts talking while "first." is still playing
    r.cutSay(true);
    r.c.stopSpeaking();
    r.release();
    await tick();
    expect(r.said).toEqual(["first."]);
    r.blockSay(false); r.cutSay(false);
    r.c.resumeHold();
    await tick();
    expect(r.said).toEqual(["first.", "first.", "second."]);
  });

  test("road noise that carried no words gives the passage back", async () => {
    const r = room();
    r.c.stopSpeaking();
    r.guts.speak("the rest.");
    r.c.heardNothing();
    await tick();
    expect(r.said).toEqual(["the rest."]);
  });

  test("a transcription that never comes back is dropped by the backstop", async () => {
    const r = room({ holdBackstopMs: 20 });
    r.c.stopSpeaking();
    r.guts.speak("the rest.");
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(r.c.onHold).toBe(false);
    expect(r.said).toEqual([]);
  });

  test("the acknowledgement is heard first, then the passage carries on", async () => {
    const r = room();
    r.c.stopSpeaking();
    r.guts.speak("the rest of the answer.");
    await r.c.heard("hey bridge mute");
    await tick();
    expect(r.said).toEqual(["Muted.", "the rest of the answer."]);
    expect(r.c.isMuted).toBe(true);
  });

  test("the wake word without a command changes nothing, so the passage carries on", async () => {
    const r = room();
    r.c.stopSpeaking();
    r.guts.speak("the rest.");
    await r.c.heard("hey bridge wtaeuhnt");
    await tick();
    // it waits for the command rather than saying anything: the pause between
    // the wake word and what follows is usually why it arrived alone
    expect(r.said).toEqual(["the rest."]);
  });

  test("where are we drops the passage, because it is for reorienting (9.4.7)", async () => {
    const r = room();
    r.guts.recent.push({ said: "what does serve do", reply: "it joins the room." });
    r.c.stopSpeaking();
    r.guts.speak("the rest.");
    await r.c.heard("hey bridge where are we");
    await tick();
    expect(r.said).toEqual(["You asked: what does serve do I said: it joins the room."]);
  });

  test("a question for the agent drops the passage", async () => {
    const r = room();
    r.c.agent.ask = async () => { throw new Error("no agent in a test"); };
    r.c.stopSpeaking();
    r.guts.speak("the rest.");
    await r.c.heard("what is the config file for");
    await tick();
    expect(r.said).toEqual(["That turn did not finish."]);
  });
});

describe("a cue never plays over the voice (15)", () => {
  test("one transport shares one audio source, and it refuses two writers", async () => {
    const r = room();
    r.blockSay(true);
    r.guts.speak("a long sentence being read out.");
    await tick();
    expect(r.said).toEqual(["a long sentence being read out."]);
    // the end-of-turn cue arrives while that sentence is still playing. On
    // 14 September this reached the transport and it threw
    // "InvalidState - failed to capture frame" into a live conversation.
    r.c.cue("heard");
    expect(r.cues).toEqual([]);
    r.blockSay(false);
    r.release();
    await tick();
    // once the voice is done, a cue is welcome again
    r.c.cue("heard");
    expect(r.cues).toEqual(["heard"]);
  });

  test("tones off still silences it, so the two guards do not fight", async () => {
    const r = room();
    await r.c.heard("hey bridge tones off");
    await tick();
    r.c.cue("thinking");
    expect(r.cues).toEqual([]);
  });
});

/**
 * Measured on 14 September: Chris leaves about 1.6 seconds between "hey
 * bridge" and the command, and the end-of-turn pause is 1.5, so the two arrive
 * as separate utterances. "Hey, bridge." got "say the command again" and
 * "Mute." went to the agent, which answered it with four paragraphs about
 * src/commands.ts and cost eleven cents.
 */
describe("the wake word on its own (9.1)", () => {
  test("the command that follows it is still the command", async () => {
    const r = room();
    await r.c.heard("Hey, bridge.");
    await r.c.heard("Mute.");
    await tick();
    expect(r.c.isMuted).toBe(true);
    expect(r.said).toEqual(["Muted."]);
  });

  test("a question after a false start reaches the agent rather than vanishing", async () => {
    const r = room();
    r.c.agent.ask = async () => { throw new Error("no agent in a test"); };
    await r.c.heard("Hey, bridge.");
    await r.c.heard("what does the serve command do");
    await tick();
    // it is not a command, so it is speech, and speech is not swallowed
    expect(r.said).toEqual(["That turn did not finish."]);
  });

  test("it does not wait for ever", async () => {
    const r = room({ wakeHoldMs: 20 });
    await r.c.heard("Hey, bridge.");
    await new Promise((resolve) => setTimeout(resolve, 40));
    r.c.agent.ask = async () => { throw new Error("no agent in a test"); };
    await r.c.heard("Mute.");
    await tick();
    // too late to be the command, so it is what it sounds like: speech
    expect(r.c.isMuted).toBe(false);
  });

  test("the hold is spent once, not left armed", async () => {
    const r = room();
    r.c.agent.ask = async () => { throw new Error("no agent in a test"); };
    await r.c.heard("Hey, bridge.");
    await r.c.heard("Mute.");
    await tick();
    expect(r.c.isMuted).toBe(true);
    await r.c.heard("Unmute.");
    await tick();
    // the second one had no wake word in front of it, so it was speech
    expect(r.c.isMuted).toBe(true);
  });
});

describe("the commands that were wrong mid-turn", () => {
  test("summarize is refused and does not corrupt the turn (9.4.6)", async () => {
    const r = room();
    r.guts.turnRunning = true;
    r.c.stopSpeaking();
    r.guts.speak("the rest.");
    await r.c.heard("hey bridge summarize");
    await tick();
    expect(r.said).toEqual([
      "I am still on the last one. Say hey bridge, end the turn, to stop it.",
      "the rest.",
    ]);
    // the turn it was told about is still the turn that is running
    expect(r.c.busy).toBe(true);
  });

  test("restate says the last sentence, not the answer before this one (9.4.5)", async () => {
    const r = room();
    r.guts.lastReply = "the answer before this one.";
    r.guts.turnRunning = true;
    r.guts.speak("the first sentence."); r.guts.speak("the second sentence.");
    await tick();
    await r.c.heard("hey bridge say that again");
    await tick();
    expect(r.said.at(-1)).toBe("the second sentence.");
  });

  test("between turns restate still means the whole last answer", async () => {
    const r = room();
    r.guts.lastReply = "the answer before this one.";
    await r.c.heard("hey bridge say that again");
    await tick();
    expect(r.said).toEqual(["the answer before this one."]);
  });
});

describe("the gate on clearing the context (10)", () => {
  test("it reads back what it is about to do and waits", async () => {
    const r = room();
    let restarted = false;
    r.c.agent.restart = () => { restarted = true; };
    await r.c.heard("hey bridge clear");
    await tick();
    expect(r.said).toEqual(["I am about to clear the context and start again. Say continue to let it happen."]);
    expect(restarted).toBe(false);
  });

  test("the agreement word lets it happen", async () => {
    const r = room();
    let restarted = false;
    r.c.agent.restart = () => { restarted = true; };
    await r.c.heard("hey bridge clear");
    await r.c.heard("continue");
    await tick();
    expect(restarted).toBe(true);
    expect(r.said.at(-1)).toBe("Context cleared.");
  });

  test("10.5 anything else fails it closed", async () => {
    const r = room();
    let restarted = false;
    r.c.agent.restart = () => { restarted = true; };
    await r.c.heard("hey bridge clear");
    await r.c.heard("hey bridge tones off");
    await tick();
    expect(restarted).toBe(false);
    expect(r.said).toEqual([
      "I am about to clear the context and start again. Say continue to let it happen.",
      "Nothing was cleared.",
      "Tones off.",
    ]);
  });

  test("the held passage waits with the gate rather than resuming under it", async () => {
    const r = room();
    r.c.agent.restart = () => {};
    r.c.stopSpeaking();
    r.guts.speak("the rest.");
    await r.c.heard("hey bridge clear");
    await tick();
    expect(r.c.onHold).toBe(true);
    expect(r.said).toEqual(["I am about to clear the context and start again. Say continue to let it happen."]);
  });
});

describe("switching voice (4.9)", () => {
  test("it changes the engine's voice and leaves the answer alone", async () => {
    const asked: string[] = [];
    const speaking = { ...engines, use: (v: string) => { asked.push(v); } };
    const said: string[] = [];
    const mouth = { say: async (t: string) => { said.push(t); return true; }, cue: () => {}, tell: () => {} };
    const c = new Conversation("/tmp", config, mouth as never, speaking as never);
    const guts = c as unknown as { speak(t: string): void };
    c.stopSpeaking();
    guts.speak("the rest of the answer.");
    await c.heard("hey bridge male voice");
    await new Promise((r) => setTimeout(r, 0));
    expect(asked).toEqual([config.voiceChoices.male]);
    expect(said).toEqual(["Switched to the male voice.", "the rest of the answer."]);
  });
  test("an engine with one voice says so rather than pretending", async () => {
    const said: string[] = [];
    const mouth = { say: async (t: string) => { said.push(t); return true; }, cue: () => {}, tell: () => {} };
    const c = new Conversation("/tmp", config, mouth as never, engines as never);
    await c.heard("hey bridge female voice");
    await new Promise((r) => setTimeout(r, 0));
    expect(said).toEqual(["This engine has only the one voice."]);
  });
});

/**
 * 9.1 the wake word arrives alone, and the command follows a moment later. The
 * utterance in that window is matched with no wake word in front of it, so the
 * table's bare single words -- stop, clear, where, man -- are live against
 * anything Chris says next.
 */
describe("the wake-word hold", () => {
  test("a short command still works after the wake word alone", async () => {
    const { c, said } = watched();
    await c.heard("hey bridge");
    await c.heard("mute");
    expect(said.at(-1)).toBe("Muted.");
  });

  test("a question is not a command, however it ends", async () => {
    const commands: string[] = [];
    const mouth = { say: async () => true, cue: () => {}, tell: () => {} };
    const asked: string[] = [];
    const c = new Conversation("/tmp", config, mouth as never, engines as never, {
      onMatched: (_said, became) => { commands.push(became); },
    });
    (c as unknown as { toAgent: (text: string) => void }).toAgent = (text: string) => { asked.push(text); };
    await c.heard("hey bridge");
    await c.heard("how do i stop the server");
    expect(commands).not.toContain("endTurn");
  });
});

/**
 * A sentence a barge-in cut is not a sentence Chris heard. Where it goes back
 * to matters: a bridge reply lives on `ahead`, and returning it to the answer
 * queue meant the next discardHold threw it away, so "Muted." went unsaid.
 */
describe("a sentence a barge-in cut", () => {
  /** A mouth that reports the first sentence as cut off, the way a barge-in does. */
  function cutOnce() {
    const said: string[] = [];
    let first = true;
    const mouth = {
      say: async (text: string) => { said.push(text); if (first) { first = false; return false; } return true; },
      cue: () => {}, tell: () => {},
    };
    const c = new Conversation("/tmp", config, mouth as never, engines as never);
    return { c, said };
  }

  test("a bridge reply goes back to the queue it came from, and the pump stops", async () => {
    // it used to be retried at once, cut at once and retried again for as long
    // as Chris kept talking. It goes back and waits for the hold to resolve.
    const attempts: string[] = [];
    const mouth = {
      say: async (text: string) => { attempts.push(text); return false; },
      cue: () => {}, tell: () => {},
    };
    const c = new Conversation("/tmp", config, mouth as never, engines as never);
    const inner = c as unknown as { ahead: string[]; outbox: string[]; holding: boolean; pump: () => Promise<void> };
    inner.holding = true;
    inner.ahead.push("Muted.");
    await inner.pump();
    expect(attempts).toEqual(["Muted."]);
    // back on `ahead`, and never on `outbox`, which a discardHold empties
    expect(inner.ahead).toEqual(["Muted."]);
    expect(inner.outbox).toEqual([]);
  });

  test("it is never counted as something he heard", async () => {
    const { c } = cutOnce();
    const inner = c as unknown as { ahead: string[]; said: string[]; holding: boolean; pump: () => Promise<void> };
    // the hold is discarded while the sentence is still playing, the way a new
    // question does it, so `holding` is already false when say() returns
    inner.holding = false;
    inner.ahead.push("half a sen");
    await inner.pump();
    expect(inner.said).toEqual([]);
  });
});

/**
 * 11.6 the gap between two sentences. The bridge says one sentence at a time
 * and waits for each, so whatever the mouth spends making a sentence lands in
 * the silence before it. The cloning voice spends three seconds. The pump
 * therefore tells the mouth which sentence comes next, so the mouth can make
 * it while the current one plays.
 */
describe("the next sentence is named before this one ends (11.6)", () => {
  test("each sentence is told the one that follows it, and the last is told nothing", async () => {
    const r = room();
    // speak() takes one sentence; the splitter is upstream of it
    r.guts.speak("One."); r.guts.speak("Two."); r.guts.speak("Three.");
    await tick();
    expect(r.said).toEqual(["One.", "Two.", "Three."]);
    expect(r.lookahead).toEqual(["Two.", "Three.", undefined]);
  });

  test("a sentence a barge-in cut is named again, not skipped past", async () => {
    const r = room();
    r.blockSay(true);
    r.guts.speak("first."); r.guts.speak("second.");
    await tick();
    expect(r.said).toEqual(["first."]);
    expect(r.lookahead).toEqual(["second."]);
    r.cutSay(true);
    r.c.stopSpeaking();
    r.release();
    await tick();
    r.blockSay(false); r.cutSay(false);
    r.c.resumeHold();
    await tick();
    // the cut sentence plays again from the start, and still names the one after
    expect(r.said).toEqual(["first.", "first.", "second."]);
    expect(r.lookahead).toEqual(["second.", "second.", undefined]);
  });
});
