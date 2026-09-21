import { describe, expect, test } from "bun:test";
import { DEFAULTS, type Config } from "../src/config.ts";
import { Channel } from "../src/channel.ts";
import { COMMAND_NAMES, spokenForms } from "../src/commands.ts";
import { Conversation } from "../src/conversation.ts";
import { Measures } from "../src/measures.ts";
import { KEPT_LINES, Mouth, type Speaker } from "../src/mouth.ts";

const config: Config = { ...DEFAULTS, historyMaxAgeMs: 60_000 };

/**
 * A mouth over a speaker that keeps what it played, and can be made to block
 * mid-sentence and to report a sentence cut short, which is what a barge-in
 * looks like from up here. Making a sentence takes one tick, the way the
 * engine takes a moment, so by then the agent has usually streamed more.
 */
function mouthFor(overrides: Partial<Config> = {}) {
  const said: string[] = [];
  const cues: string[] = [];
  const lookahead: Array<string | undefined> = [];
  const switched: string[] = [];
  let gate: (() => void) | null = null;
  let blocking = false;
  let whole = true;
  const speaker: Speaker = {
    async play(text) {
      said.push(text);
      if (blocking) await new Promise<void>((resolve) => { gate = resolve; });
      return whole;
    },
    cue(wav) { cues.push(wav); },
    track: () => null,
  };
  const made = { take: async (text: string) => text, start: (text: string | undefined) => { lookahead.push(text); }, use: (voice: string) => { switched.push(voice); return true; } };
  const mouth = new Mouth(speaker, made, { file: (name) => name }, new Measures(), { ...config, ...overrides });
  return {
    mouth, said, cues, lookahead, switched,
    blockSay: (on: boolean) => { blocking = on; },
    cutSay: (on: boolean) => { whole = !on; },
    release: () => { gate?.(); gate = null; },
  };
}

/** A channel nobody is listening to: what a client is told is channel.test.ts's business. */
function quiet(settings: Config = config): Channel {
  return new Channel(settings, () => {}, { heard: async () => {}, microphone: () => {}, voice: () => {}, quality: () => false }, () => {});
}

/** A conversation whose mouth keeps what it said, so a command can be checked. */
function watched() {
  const m = mouthFor();
  const c = new Conversation("/tmp", config, m.mouth, quiet());
  return { c, said: m.said, cues: m.cues };
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
    await c.heard("sidetone tones off");
    expect(c.tonesOn).toBe(false);
    c.cue("thinking");
    c.cue("heard");
    expect(cues).toEqual(["thinking"]);
  });
  test("the bare word toggles, so it can be said twice while driving", async () => {
    const { c } = watched();
    await c.heard("sidetone tones");
    expect(c.tonesOn).toBe(false);
    await c.heard("sidetone tones");
    expect(c.tonesOn).toBe(true);
  });
  test("the explicit form does not flip what is already right", async () => {
    const { c } = watched();
    await c.heard("sidetone tones off");
    await c.heard("sidetone tones off");
    expect(c.tonesOn).toBe(false);
  });
  test("turning them off is still answered out loud (15.1)", async () => {
    const { c, said } = watched();
    await c.heard("sidetone tones off");
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
    await c.heard("sidetone stats");
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
    await c.heard("sidetone stats");
    await settled();
    expect(said.at(-1)).toBe("The phone's connection is poor and this end is excellent.");
  });
  test("with nothing measured it says so", async () => {
    const { c, said } = watched();
    await c.heard("sidetone latency");
    await settled();
    expect(said).toEqual([
      "No round trip has been measured yet.",
      "Nothing has reported on the connection yet.",
    ]);
  });
});

/** A room: the conversation over a scripted mouth. A turn in flight is turn.test.ts's business. */
function room(overrides: Partial<Config> = {}) {
  const m = mouthFor(overrides);
  const c = new Conversation("/tmp", { ...config, ...overrides }, m.mouth, quiet({ ...config, ...overrides }));
  return {
    c, mouth: m.mouth, said: m.said, cues: m.cues, lookahead: m.lookahead,
    blockSay: m.blockSay,
    cutSay: m.cutSay,
    release: m.release,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the hold (11.3)", () => {
  test("the acknowledgement is heard first, then the passage carries on", async () => {
    const r = room();
    r.c.ears.stopSpeaking();
    r.mouth.say("the rest of the answer.");
    await r.c.heard("sidetone mute");
    await tick();
    expect(r.said).toEqual(["Muted.", "the rest of the answer."]);
    expect(r.c.isMuted).toBe(true);
  });

  test("the wake word without a command changes nothing, so the passage carries on", async () => {
    const r = room();
    r.c.ears.stopSpeaking();
    r.mouth.say("the rest.");
    await r.c.heard("sidetone wtaeuhnt");
    await tick();
    // it waits for the command rather than saying anything: the pause between
    // the wake word and what follows is usually why it arrived alone
    expect(r.said).toEqual(["the rest."]);
  });


  test("a question for the agent drops the passage", async () => {
    const r = room();
    r.c.agent.ask = async () => { throw new Error("no agent in a test"); };
    r.c.ears.stopSpeaking();
    r.mouth.say("the rest.");
    await r.c.heard("what is the config file for");
    await tick();
    expect(r.said).toEqual(["That turn did not finish."]);
  });
});

describe("a cue never plays over the voice (15)", () => {
  test("tones off still silences it, so the two guards do not fight", async () => {
    const r = room();
    await r.c.heard("sidetone tones off");
    await tick();
    r.c.cue("thinking");
    expect(r.cues).toEqual([]);
  });
});

/**
 * Measured on 14 September, with "hey bridge" as the wake word: Chris leaves
 * about 1.6 seconds between the wake word and the command, and the end-of-turn
 * pause is 1.5, so the two arrive as separate utterances. "Hey, bridge." got
 * "say the command again" and
 * "Mute." went to the agent, which answered it with four paragraphs about
 * src/commands.ts and cost eleven cents.
 */
describe("the wake word on its own (9.1)", () => {
  test("the command that follows it is still the command", async () => {
    const r = room();
    await r.c.heard("Sidetone.");
    await r.c.heard("Mute.");
    await tick();
    expect(r.c.isMuted).toBe(true);
    expect(r.said).toEqual(["Muted."]);
  });

  test("a question after a false start reaches the agent rather than vanishing", async () => {
    const r = room();
    r.c.agent.ask = async () => { throw new Error("no agent in a test"); };
    await r.c.heard("Sidetone.");
    await r.c.heard("what does the serve command do");
    await tick();
    // it is not a command, so it is speech, and speech is not swallowed
    expect(r.said).toEqual(["That turn did not finish."]);
  });

  test("it does not wait for ever", async () => {
    const r = room({ wakeHoldMs: 20 });
    await r.c.heard("Sidetone.");
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
    await r.c.heard("Sidetone.");
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


});

describe("a setting changed out loud is handed on (9.4)", () => {
  test("interrupt, tones and the voice reach the hook as the setting they change", async () => {
    const patches: Array<Record<string, unknown>> = [];
    const c = new Conversation("/tmp", config, mouthFor().mouth, quiet(), { onSetting: (patch) => patches.push(patch) });
    await c.heard("sidetone interrupt on");
    await c.heard("sidetone tones off");
    await c.heard("sidetone male voice");
    expect(patches).toEqual([{ interruptOnSpeech: true }, { tones: false }, { ttsVoice: config.voiceChoices.male }]);
  });
});

describe("end the turn with no turn running (9.4.8)", () => {
  test("the command itself is a barge-in, and still it says nothing is running", async () => {
    const { c, said } = watched();
    c.ears.stopSpeaking();
    await c.heard("sidetone end the turn");
    await settled();
    expect(said).toEqual(["Nothing is running."]);
  });

  test("with nothing queued it says so", async () => {
    const r = room();
    await r.c.heard("sidetone end the turn");
    await tick();
    expect(r.said).toEqual(["Nothing is running."]);
  });

  test("a replay from carry on is stopped, and the stop is heard at once", async () => {
    const r = room();
    r.c.ears.stopSpeaking();
    r.mouth.say("two."); r.mouth.say("three.");
    r.mouth.discard();
    r.blockSay(true);
    await r.c.heard("sidetone carry on");
    await tick();
    expect(r.said).toEqual(["two."]);
    // Chris talks over the replay, and what he said is the stop
    r.cutSay(true);
    r.c.ears.stopSpeaking();
    r.release();
    await tick();
    r.cutSay(false); r.blockSay(false);
    await r.c.heard("sidetone end the turn");
    await tick();
    expect(r.said).toEqual(["two.", "Stopped."]);
  });
});

describe("the gate on clearing the context (10)", () => {
  test("it reads back what it is about to do and waits", async () => {
    const r = room();
    let restarted = false;
    r.c.agent.restart = () => { restarted = true; };
    await r.c.heard("sidetone clear");
    await tick();
    expect(r.said).toEqual(["I am about to clear the context and start again. Say continue to let it happen."]);
    expect(restarted).toBe(false);
  });

  test("the agreement word lets it happen", async () => {
    const r = room();
    let restarted = false;
    r.c.agent.restart = () => { restarted = true; };
    await r.c.heard("sidetone clear");
    await r.c.heard("continue");
    await tick();
    expect(restarted).toBe(true);
    expect(r.said.at(-1)).toBe("Context cleared.");
  });

  test("10.5 anything else fails it closed", async () => {
    const r = room();
    let restarted = false;
    r.c.agent.restart = () => { restarted = true; };
    await r.c.heard("sidetone clear");
    await r.c.heard("sidetone tones off");
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
    r.c.ears.stopSpeaking();
    r.mouth.say("the rest.");
    await r.c.heard("sidetone clear");
    await tick();
    expect(r.mouth.onHold).toBe(true);
    expect(r.said).toEqual(["I am about to clear the context and start again. Say continue to let it happen."]);
  });
});

describe("switching voice (4.9)", () => {
  test("it changes the voice, keeps the setting, and leaves the answer alone", async () => {
    const m = mouthFor();
    const patches: Array<Record<string, unknown>> = [];
    const c = new Conversation("/tmp", config, m.mouth, quiet(), { onSetting: (patch) => patches.push(patch) });
    c.ears.stopSpeaking();
    m.mouth.say("the rest of the answer.");
    await c.heard("sidetone male voice");
    await new Promise((r) => setTimeout(r, 0));
    expect(m.switched).toEqual([config.voiceChoices.male]);
    expect(patches).toEqual([{ ttsVoice: config.voiceChoices.male }]);
    expect(m.said).toEqual(["Switched to the male voice.", "the rest of the answer."]);
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
    await c.heard("sidetone");
    await c.heard("mute");
    expect(said.at(-1)).toBe("Muted.");
  });

  test("a question is not a command, however it ends", async () => {
    const m = mouthFor();
    const c = new Conversation("/tmp", config, m.mouth, quiet());
    await c.heard("sidetone");
    await c.heard("how do i stop the server");
    const commands = m.mouth.measures.recent().flatMap((e) => (e.kind === "matched" ? [e.became] : []));
    expect(commands).not.toContain("endTurn");
  });
});

/**
 * 11.6 the kept lines are the sentences the bridge says word for word, made
 * once and kept. The list used to be kept by hand, and the code drifted from
 * it: "Interrupting on." and "Stopped." were made the slow way every session.
 * This says every fixed line a command answers with from a fresh start, and
 * checks the list has it. A line with a number in it is not fixed and is not
 * checked, and neither is the one that names the agreement word, which is
 * built from a setting; usage and clear the context say nothing else.
 */
describe("the kept lines (11.6)", () => {
  const first = new Map<string, string>();
  for (const { said, want } of spokenForms(config.wakeWord)) if (!first.has(want)) first.set(want, said);

  for (const name of COMMAND_NAMES) {
    test(`every fixed line "${name}" says from a fresh start is a kept line`, async () => {
      const { c, said } = watched();
      await c.heard(first.get(name) as string);
      await settled();
      expect(said.length).toBeGreaterThan(0);
      const fixed = said.filter((line) => !/\d/.test(line) && !line.includes(config.agreementWord));
      for (const line of fixed) expect(KEPT_LINES as readonly string[]).toContain(line);
    });
  }
});
