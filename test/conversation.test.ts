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

describe("the tones from the app (item 28)", () => {
  test("the app's switch goes the spoken path, and a client reads it back", async () => {
    const r = room();
    r.c.set({ tones: false });
    await settled();
    expect(r.c.tonesOn).toBe(false);
    expect(r.said).toEqual(["Tones off."]);
    const settings = r.told.filter((message) => message.kind === "settings").at(-1);
    expect(settings).toMatchObject({ settings: { tones: false } });
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

/**
 * Item 37 how much the agent says. The bridge holds the level and names it in
 * one line at the head of every turn's prompt; the command and the app set the
 * same value, and the file keeps it.
 */
describe("the verbosity (item 37)", () => {
  const asked = (r: ReturnType<typeof room>) => r.agent.calls.filter((call) => call.startsWith("ask ")).at(-1) ?? "";
  const line = (prompt: string) => prompt.slice("ask ".length).split("\n")[0];

  test("every turn's prompt opens with one line that names the level", async () => {
    const r = room();
    await r.c.turn("what is two plus two");
    expect(line(asked(r))).toContain("verbosity is normal");
    expect(asked(r)).toEndWith("\n\nwhat is two plus two");
  });

  test("the command sets the level, says so, keeps it, and the next turn has it", async () => {
    const r = room();
    await r.c.heard("sidetone verbosity brief");
    await settled();
    expect(r.said).toContain("Verbosity brief.");
    expect(r.patches).toEqual([{ verbosity: "brief" }]);
    await r.c.turn("what is two plus two");
    expect(line(asked(r))).toContain("verbosity is brief");
    await r.c.heard("sidetone verbosity full");
    await r.c.turn("and three");
    expect(line(asked(r))).toContain("verbosity is full");
  });

  test("the level in the settings file is the level of the first turn", async () => {
    const r = room({ verbosity: "full" });
    await r.c.turn("why");
    expect(line(asked(r))).toContain("verbosity is full");
  });

  test("shorter and longer move one level, and stop at the ends", async () => {
    const r = room();
    await r.c.heard("sidetone shorter");
    await r.c.heard("sidetone shorter");
    await r.c.heard("sidetone longer");
    await r.c.heard("sidetone longer");
    await r.c.heard("sidetone longer");
    expect(r.patches).toEqual([
      { verbosity: "brief" }, { verbosity: "brief" }, { verbosity: "normal" }, { verbosity: "full" }, { verbosity: "full" },
    ]);
  });

  test("the app sets the same value by the same path, and a level that does not exist is ignored", async () => {
    const r = room();
    r.c.set({ verbosity: "brief" });
    r.c.set({ verbosity: "loud" });
    await settled();
    expect(r.patches).toEqual([{ verbosity: "brief" }]);
    expect(r.said).toContain("Verbosity brief.");
  });

  test("a client reads the level back in the settings message", async () => {
    const r = room();
    await r.c.heard("sidetone verbosity full");
    const settings = r.told.filter((message) => message.kind === "settings").at(-1);
    expect(settings).toMatchObject({ settings: { verbosity: "full" } });
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
    await r.c.heard("sidetone clear context");
    await tick();
    expect(r.said).toEqual(["I am about to clear the context and start again. Say continue to let it happen."]);
    expect(restarted()).toBe(false);
  });

  test("the agreement word lets it happen", async () => {
    const r = room();
    const restarted = () => r.agent.calls.includes("restart cleared by voice");
    await r.c.heard("sidetone clear context");
    await r.c.heard("continue");
    await tick();
    expect(restarted()).toBe(true);
    expect(r.said.at(-1)).toBe("Context cleared.");
  });

  test("10.5 anything else fails it closed", async () => {
    const r = room();
    const restarted = () => r.agent.calls.includes("restart cleared by voice");
    await r.c.heard("sidetone clear context");
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
    await r.c.heard("sidetone clear context");
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

describe("the bridge's own echo (18.10)", () => {
  const sentence = "Ilse carried the logbook up the tower, because she had decided that if the sea took the cottage, it would not take the record.";
  const echo = "ilse carried the log book up the tower because she had decided";

  /** The voice says the sentence, then a barge-in holds the rest of the passage. */
  async function played() {
    const r = room();
    r.mouth.say(sentence);
    await tick();
    r.c.ears.stopSpeaking();
    r.mouth.say("the rest.");
    return r;
  }

  test("an echo that began while the voice played is dropped, and the passage resumes", async () => {
    const r = await played();
    await r.c.heard(echo, Date.now() - 3_000);
    await tick();
    expect(r.said).toEqual([sentence, "the rest."]);
    expect(r.told.some((message) => message.kind === "heard")).toBe(false);
    expect(r.journal).toContain(`[the bridge dropped "${echo}" as its own echo of "${sentence}"]`);
  });

  test("an echo that began more than a second after the voice stopped is heard", async () => {
    const r = await played();
    await r.c.heard(echo, Date.now() + 1_500);
    await tick();
    expect(r.said).not.toContain("the rest.");
    expect(r.told.some((message) => message.kind === "heard")).toBe(true);
  });

  test("words with no start, typed rather than spoken, are heard", async () => {
    const r = await played();
    await r.c.heard(echo);
    await tick();
    expect(r.told.some((message) => message.kind === "heard")).toBe(true);
  });

  test("a command the voice just told Chris to say is not dropped", async () => {
    const r = room();
    r.mouth.say("Say sidetone, music off, to stop it.");
    await tick();
    await r.c.heard("sidetone music off", Date.now() - 1_000);
    await settled();
    expect(r.c.musicOn).toBe(false);
  });
});

/**
 * 15.15 the cue at the end of the speech. It says the turn is done speaking,
 * as against paused between two sentences: the pause is where Chris could not
 * tell, and the cue is what tells him. It comes after the last sentence has
 * played, so the mouth is what it waits for, and only the conversation knows
 * that the sentence was the last.
 */
describe("the cue at the end of the speech (15.15)", () => {
  /** A turn whose agent says nothing before its result comes back. */
  const silent: Script = { deltas: [] };

  test("it plays once, after the last sentence has played, and never between two", async () => {
    const r = room({}, { deltas: ["One. ", "Two."] });
    r.blockSay(true);
    const turn = r.c.turn("what is two plus two");
    await tick();
    // the agent's result is back and both sentences are queued: the first is playing
    expect(r.said).toEqual(["One."]);
    expect(r.cues).toEqual([]);
    r.release();
    await tick();
    // between the sentences of one turn: nothing
    expect(r.said).toEqual(["One.", "Two."]);
    expect(r.cues).toEqual([]);
    r.release();
    await turn;
    expect(r.cues).toEqual(["done"]);
  });

  test("a turn with no speech gets nothing", async () => {
    const r = room({}, silent);
    await r.c.turn("what is two plus two");
    expect(r.said).toEqual([]);
    expect(r.cues).toEqual([]);
  });

  test("tones off silences it, like the others (15.4)", async () => {
    const r = room({}, { deltas: ["Four."] });
    await r.c.heard("sidetone tones off");
    await r.c.turn("what is two plus two");
    expect(r.said).toEqual(["Tones off.", "Four."]);
    expect(r.cues).toEqual([]);
  });

  test("a report the agent began unasked gets it too (11.11)", async () => {
    const r = room();
    const hooks = r.agent.hooks();
    hooks.onDelta?.("Job research finished. ");
    hooks.onDelta?.("The file is written.");
    hooks.onUnprompted?.({ number: 2, text: "Job research finished. The file is written.", costUsd: 0.01, isError: false });
    await settled();
    await tick();
    expect(r.said).toEqual(["Job research finished.", "The file is written."]);
    expect(r.cues).toEqual(["done"]);
  });

  test("an unasked result with no words gets nothing", async () => {
    const r = room();
    r.agent.hooks().onUnprompted?.({ number: 2, text: "", costUsd: 0.01, isError: false });
    await tick();
    expect(r.cues).toEqual([]);
  });

  test("a hold is not the end: the cue waits for the held rest", async () => {
    const r = room({}, { deltas: ["One. ", "Two."] });
    r.blockSay(true);
    const turn = r.c.turn("what is two plus two");
    await tick();
    // Chris talks over the first sentence, and what he said is a command
    r.cutSay(true);
    r.c.ears.stopSpeaking();
    r.release();
    await tick();
    r.cutSay(false); r.blockSay(false);
    expect(r.mouth.onHold).toBe(true);
    expect(r.cues).toEqual([]);
    await r.c.heard("sidetone mute");
    await turn;
    expect(r.said).toEqual(["One.", "Muted.", "One.", "Two."]);
    expect(r.cues).toEqual(["done"]);
  });

  test("a barge-in that ends the turn early gets none: the new question owns the mouth", async () => {
    let end = () => {};
    const hold = new Promise<void>((resolve) => { end = resolve; });
    // the first turn says a sentence and runs on; the turn the question starts says nothing
    let asked = 0;
    const r = room({ interruptOnSpeech: true, interruptAfterMs: 5 }, {
      during: (hooks) => { if (asked++ === 0) hooks.onDelta?.("The first sentence. "); },
      hold,
      onInterrupt: () => end(),
    });
    const turn = r.c.turn("how does a suspension bridge work");
    await tick();
    expect(r.said).toEqual(["The first sentence."]);
    r.c.ears.stopSpeaking();
    await r.c.heard("what is the tallest one");
    await turn;
    await settled();
    expect(asked).toBe(2);
    expect(r.cues).toEqual([]);
  });

  test("end the turn: the turn spoke and it is over, so the cue follows the stop", async () => {
    let end = () => {};
    const hold = new Promise<void>((resolve) => { end = resolve; });
    const r = room({}, { during: (hooks) => hooks.onDelta?.("The first sentence. "), hold, onInterrupt: () => end() });
    const turn = r.c.turn("how does a suspension bridge work");
    await tick();
    r.c.ears.stopSpeaking();
    await r.c.heard("sidetone end the turn");
    await turn;
    expect(r.said).toEqual(["The first sentence.", "Stopped."]);
    expect(r.cues).toEqual(["done"]);
  });

  test("carry on: the kept rest is the end of that turn's speech, so it ends with the cue", async () => {
    const r = room();
    r.c.ears.stopSpeaking();
    r.mouth.say("two."); r.mouth.say("three.");
    r.mouth.discard();
    await r.c.heard("sidetone carry on");
    await tick();
    expect(r.said).toEqual(["two.", "three."]);
    expect(r.cues).toEqual(["done"]);
  });

  test("a replay a new question cut gets none", async () => {
    const r = room({}, silent);
    r.c.ears.stopSpeaking();
    r.mouth.say("two."); r.mouth.say("three.");
    r.mouth.discard();
    r.blockSay(true);
    await r.c.heard("sidetone carry on");
    await tick();
    expect(r.said).toEqual(["two."]);
    r.cutSay(true);
    r.c.ears.stopSpeaking();
    r.release();
    await tick();
    r.cutSay(false); r.blockSay(false);
    await r.c.heard("what is the config file for");
    await tick();
    expect(r.said).toEqual(["two."]);
    expect(r.cues).toEqual([]);
  });
});
