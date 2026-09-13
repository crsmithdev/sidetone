import { describe, expect, test } from "bun:test";
import { DEFAULTS } from "../src/config.ts";
import { afterWakeWord, commandIn, match } from "../src/commands.ts";

const WAKE = DEFAULTS.wakeWord;
const MUTED = DEFAULTS.mutedCommands;

describe("wake word (9.3)", () => {
  test("the spelling the engine chose does not matter", () => {
    // every one of these is a way small.en has to write the same sound
    for (const said of ["hey bridge mute", "Hey, Bridge! Mute.", "heybridge mute", "hey brige mute", "hey bridged mute"]) {
      expect(afterWakeWord(said, WAKE)).toBe("mute");
    }
  });
  test("a false start in front of the wake word is ignored", () => {
    expect(afterWakeWord("um, hey bridge, report the usage", WAKE)).toBe("report the usage");
  });
  test("speech that does not carry the wake word is speech", () => {
    expect(afterWakeWord("what does the bridge do", WAKE)).toBeNull();
    expect(match("what does the bridge do", WAKE, false, MUTED)).toEqual({ kind: "speech" });
  });
  test("a sentence that only looks like the wake word is not one", () => {
    // "thebridge" is two characters from "heybridge" and nothing like it in sound
    expect(afterWakeWord("the bridge is ready", WAKE)).toBeNull();
    expect(afterWakeWord("tell the bridge to mute", WAKE)).toBeNull();
  });
  test("9.1 the command starts with the wake word, so a late one does not count", () => {
    expect(afterWakeWord("I was going to say hey bridge mute", WAKE)).toBeNull();
  });
});

describe("what the engine actually writes (9.3, 18.8)", () => {
  test("a form the engine produces is accepted as the wake word", () => {
    // small.en writes "hey bridge" as "Cambridge" about half the time
    expect(afterWakeWord("Cambridge, say that again.", WAKE)).toBeNull();
    expect(afterWakeWord("Cambridge, say that again.", WAKE, DEFAULTS.wakeWordVariants)).toBe("say that again");
    expect(match("Cambridge, mute.", WAKE, false, MUTED, DEFAULTS.wakeWordVariants)).toEqual({ kind: "command", name: "mute" });
  });
  test("a variant still has to come at the start", () => {
    expect(afterWakeWord("I studied at Cambridge for a while", WAKE, DEFAULTS.wakeWordVariants)).toBeNull();
  });
});

describe("commands (9.4)", () => {
  test("each command is found by its words, not by an exact phrase", () => {
    expect(commandIn("mute")).toBe("mute");
    expect(commandIn("unmute")).toBe("unmute");
    expect(commandIn("clear the context")).toBe("clearContext");
    expect(commandIn("report the usage")).toBe("usage");
    expect(commandIn("say that again")).toBe("restate");
    expect(commandIn("summarize the last answer")).toBe("summarize");
    expect(commandIn("report where we are")).toBe("where");
    expect(commandIn("end the turn")).toBe("endTurn");
  });
  test("unmute is not read as mute", () => {
    expect(commandIn("unmute")).toBe("unmute");
    expect(commandIn("un mute")).toBe("unmute");
  });
  test("9.7 the wake word without a command asks for the command again", () => {
    expect(match("hey bridge do the thing", WAKE, false, MUTED)).toEqual({ kind: "unclear" });
  });
});

describe("muted (9.5, 9.6)", () => {
  test("only the commands in the setting work while muted", () => {
    expect(match("hey bridge unmute", WAKE, true, MUTED)).toEqual({ kind: "command", name: "unmute" });
    expect(match("hey bridge mute", WAKE, true, MUTED)).toEqual({ kind: "command", name: "mute" });
    expect(match("hey bridge report the usage", WAKE, true, MUTED)).toEqual({ kind: "unclear" });
  });
  test("the set is a list, so it grows without a change to the code", () => {
    expect(match("hey bridge report the usage", WAKE, true, [...MUTED, "usage"])).toEqual({ kind: "command", name: "usage" });
  });
});

describe("the tone and stats commands", () => {
  test("the explicit forms win over the toggle", () => {
    expect(commandIn("tones off")).toBe("tonesOff");
    expect(commandIn("turn the tones off")).toBe("tonesOff");
    expect(commandIn("sounds off")).toBe("tonesOff");
    expect(commandIn("tones on")).toBe("tonesOn");
    expect(commandIn("tones")).toBe("tones");
  });
  test("the diagnostic printout has a few names", () => {
    for (const said of ["stats", "the stats", "latency", "how fast are we"]) {
      expect(commandIn(said)).toBe("stats");
    }
  });
  test("the new words do not steal an older command", () => {
    expect(commandIn("mute")).toBe("mute");
    expect(commandIn("stop")).toBe("endTurn");
    expect(commandIn("end the turn")).toBe("endTurn");
    expect(commandIn("unmute")).toBe("unmute");
    expect(commandIn("report the usage")).toBe("usage");
  });
  test("9.5 the tones can be silenced while muted, and the reports cannot", () => {
    expect(match("hey bridge tones off", WAKE, true, MUTED)).toEqual({ kind: "command", name: "tonesOff" });
    expect(match("hey bridge stats", WAKE, true, MUTED)).toEqual({ kind: "unclear" });
    expect(match("hey bridge stats", WAKE, false, MUTED)).toEqual({ kind: "command", name: "stats" });
  });
});

describe("the two voices (9.4)", () => {
  test("9.3 the forms the engine writes, which is not how it is spelled", () => {
    expect(commandIn("female voice")).toBe("femaleVoice");
    expect(commandIn("male voice")).toBe("maleVoice");
    // both observed on a real run: small.en hears "male" as "mail", and drops
    // the second word about as often as it keeps it
    expect(commandIn("mail voice")).toBe("maleVoice");
    expect(commandIn("mail")).toBe("maleVoice");
    expect(commandIn("use the man voice")).toBe("maleVoice");
  });
  test("it does not steal mute, which is the neighbour that would hurt", () => {
    expect(commandIn("mute")).toBe("mute");
    expect(commandIn("stop listening")).toBe("mute");
    expect(commandIn("female voice")).not.toBe("maleVoice");
  });
});
