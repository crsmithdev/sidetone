import { describe, expect, test } from "bun:test";
import { DEFAULTS, type Config } from "../src/config.ts";
import { COMMAND_NAMES, spokenForms } from "../src/commands.ts";
import { KEPT_LINES } from "../src/mouth.ts";
import { bridge, type Script } from "./harness.ts";

const config: Config = { ...DEFAULTS, historyMaxAgeMs: 60_000 };

/** A conversation whose mouth keeps what it said, so a command can be checked. */
function watched() {
  return bridge({ overrides: config });
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

describe("the hold music switch (15.7.3)", () => {
  test("each form is answered out loud, and the answer is a kept line", async () => {
    const { c, said } = watched();
    await c.heard("sidetone music off");
    await settled();
    await c.heard("sidetone music on");
    await settled();
    expect(said).toEqual(["Music off.", "Music on."]);
  });
  test("the setting reaches the hook, and the explicit form does not flip what is already right", async () => {
    const { c, patches } = room();
    await c.heard("sidetone music off");
    await c.heard("sidetone music off");
    await c.heard("sidetone music on");
    expect(patches).toEqual([{ holdMusic: false }, { holdMusic: false }, { holdMusic: true }]);
  });
  test("the app's button sets the same setting, and is not answered (17.10)", async () => {
    const { c, patches, said } = room();
    c.setMusic(false);
    expect(c.musicOn).toBe(false);
    c.setMusic(true);
    await settled();
    expect(c.musicOn).toBe(true);
    expect(patches).toEqual([{ holdMusic: false }, { holdMusic: true }]);
    // 17.10 the button shows its own state, so the voice says nothing about it
    expect(said).toEqual([]);
  });
  test("the tones are left as they were", async () => {
    const { c } = watched();
    await c.heard("sidetone music off");
    expect(c.tonesOn).toBe(true);
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

/** A room: the whole bridge over fake engines. A turn in flight is turn.test.ts's business. */
function room(overrides: Partial<Config> = {}, script: Script = {}) {
  return bridge({ overrides: { ...config, ...overrides }, script });
}

/** An agent that fails every turn, so a question is seen to reach it. */
const failing: Script = { fail: "no agent in a test" };

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
    const r = room({}, failing);
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
    const r = room({}, failing);
    await r.c.heard("Sidetone.");
    await r.c.heard("what does the serve command do");
    await tick();
    // it is not a command, so it is speech, and speech is not swallowed
    expect(r.said).toEqual(["That turn did not finish."]);
  });

  test("it does not wait for ever", async () => {
    const r = room({ wakeHoldMs: 20 }, failing);
    await r.c.heard("Sidetone.");
    await new Promise((resolve) => setTimeout(resolve, 40));
    await r.c.heard("Mute.");
    await tick();
    // too late to be the command, so it is what it sounds like: speech
    expect(r.c.isMuted).toBe(false);
  });

  test("the hold is spent once, not left armed", async () => {
    const r = room({}, failing);
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
    const { c, patches } = room();
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
    const restarted = () => r.agent.calls.includes("restart cleared by voice");
    await r.c.heard("sidetone clear");
    await tick();
    expect(r.said).toEqual(["I am about to clear the context and start again. Say continue to let it happen."]);
    expect(restarted()).toBe(false);
  });

  test("the agreement word lets it happen", async () => {
    const r = room();
    const restarted = () => r.agent.calls.includes("restart cleared by voice");
    await r.c.heard("sidetone clear");
    await r.c.heard("continue");
    await tick();
    expect(restarted()).toBe(true);
    expect(r.said.at(-1)).toBe("Context cleared.");
  });

  test("10.5 anything else fails it closed", async () => {
    const r = room();
    const restarted = () => r.agent.calls.includes("restart cleared by voice");
    await r.c.heard("sidetone clear");
    await r.c.heard("sidetone tones off");
    await tick();
    expect(restarted()).toBe(false);
    expect(r.said).toEqual([
      "I am about to clear the context and start again. Say continue to let it happen.",
      "Nothing was cleared.",
      "Tones off.",
    ]);
  });

  test("the held passage waits with the gate rather than resuming under it", async () => {
    const r = room();
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
    const r = room();
    const { c, patches } = r;
    c.ears.stopSpeaking();
    r.mouth.say("the rest of the answer.");
    await c.heard("sidetone male voice");
    await new Promise((r) => setTimeout(r, 0));
    expect(r.switched).toEqual([config.voiceChoices.male]);
    expect(patches).toEqual([{ ttsVoice: config.voiceChoices.male }]);
    expect(r.said).toEqual(["Switched to the male voice.", "the rest of the answer."]);
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
    const { c, mouth } = room();
    await c.heard("sidetone");
    await c.heard("how do i stop the server");
    const commands = mouth.measures.recent().flatMap((e) => (e.kind === "matched" ? [e.became] : []));
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

/**
 * The table at the top of src/conversation.ts, one row at a time. Each row
 * holds a passage behind a barge-in, says one thing, and reads what became of
 * the passage: said, dropped, or still held.
 */
describe("what an utterance does to the hold: the table (11.3)", () => {
  type Want = "resumes" | "dropped" | "held";
  interface Row {
    said: string;
    want: Want;
    /** what happened before the barge-in */
    before?: (r: ReturnType<typeof room>) => Promise<void>;
    /** a turn runs while it is said */
    midTurn?: boolean;
    overrides?: Partial<Config>;
    script?: Script;
  }
  const answered = async (r: ReturnType<typeof room>) => { await r.c.turn("what does serve do"); };
  const rows: Row[] = [
    { said: "sidetone mute", want: "resumes" },
    { said: "sidetone unmute", want: "resumes" },
    { said: "sidetone tones off", want: "resumes" },
    { said: "sidetone music off", want: "resumes" },
    { said: "sidetone male voice", want: "resumes" },
    { said: "sidetone interrupt on", want: "resumes" },
    { said: "sidetone report the usage", want: "resumes" },
    { said: "sidetone stats", want: "resumes" },
    { said: "sidetone say that again", want: "resumes" },
    { said: "sidetone wtaeuhnt", want: "resumes" },
    { said: "what is the config file for", want: "resumes", before: async (r) => { await r.c.heard("sidetone mute"); } },
    { said: "sidetone where are we", want: "dropped", before: answered, script: { deltas: ["It joins the room."] } },
    { said: "sidetone summarize", want: "resumes", midTurn: true },
    { said: "sidetone summarize", want: "dropped", before: answered, script: { deltas: ["It joins the room."] } },
    { said: "what is the config file for", want: "dropped" },
    { said: "what is the tallest one", want: "resumes", midTurn: true, overrides: { interruptOnSpeech: false } },
    { said: "what is the tallest one", want: "dropped", midTurn: true, overrides: { interruptOnSpeech: true, interruptAfterMs: 5 } },
    { said: "sidetone carry on", want: "resumes" },
    { said: "sidetone end the turn", want: "dropped" },
    { said: "sidetone end the turn", want: "dropped", midTurn: true },
    { said: "sidetone clear the context", want: "held" },
    { said: "continue", want: "dropped", before: async (r) => { await r.c.heard("sidetone clear the context"); } },
    { said: "continue", want: "resumes", midTurn: true, script: { during: (hooks) => hooks.onCheckpoint?.(600_000) } },
  ];

  for (const row of rows) {
    const when = row.midTurn ? "mid-turn" : row.before ? "after a setup" : "between turns";
    const extra = row.overrides ? ` ${JSON.stringify(row.overrides)}` : "";
    test(`"${row.said}", ${when}${extra}: the held passage ${row.want}`, async () => {
      let end = () => {};
      const hold = new Promise<void>((resolve) => { end = resolve; });
      const r = room(row.overrides, row.midTurn ? { ...row.script, hold, onInterrupt: () => end() } : row.script);
      await row.before?.(r);
      const turn = row.midTurn ? r.c.turn("how does a suspension bridge work") : undefined;
      await tick();
      r.c.ears.stopSpeaking();
      r.mouth.say("the rest.");
      await r.c.heard(row.said);
      await tick();
      if (row.want === "resumes") expect(r.said).toContain("the rest.");
      else expect(r.said).not.toContain("the rest.");
      expect(r.mouth.onHold).toBe(row.want === "held");
      end();
      await turn;
    });
  }

  test("noise resumes the held passage", async () => {
    const r = room();
    r.c.ears.stopSpeaking();
    r.mouth.say("the rest.");
    r.c.ears.heardNothing();
    await tick();
    expect(r.said).toContain("the rest.");
  });

  test("a gate that times out resumes the held passage", async () => {
    const r = room({ checkpointWindowMs: 10 });
    r.c.ears.stopSpeaking();
    r.mouth.say("the rest.");
    await r.c.heard("sidetone clear the context");
    await tick();
    expect(r.mouth.onHold).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(r.said).toEqual(["I am about to clear the context and start again. Say continue to let it happen.", "Nothing was cleared.", "the rest."]);
  });
});
