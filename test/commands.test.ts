import { describe, expect, test } from "bun:test";
import { DEFAULTS } from "../src/config.ts";
import { afterWakeWord, commandIn, match } from "../src/commands.ts";

const WAKE = DEFAULTS.wakeWord;
const MUTED = DEFAULTS.mutedCommands;

describe("wake word (9.3)", () => {
  test("the spelling the engine chose does not matter", () => {
    // every one of these is a way small.en has to write the same sound
    for (const said of ["sidetone mute", "Sidetone! Mute.", "Sidetone, mute.", "sidetne mute", "sidetoned mute"]) {
      expect(afterWakeWord(said, WAKE)).toBe("mute");
    }
  });
  test("a false start in front of the wake word is ignored", () => {
    expect(afterWakeWord("um, sidetone, report the usage", WAKE)).toBe("report the usage");
  });
  test("speech that does not carry the wake word is speech", () => {
    expect(afterWakeWord("what does the bridge do", WAKE)).toBeNull();
    expect(match("what does the bridge do", WAKE, false, MUTED)).toEqual({ kind: "speech" });
  });
  test("a sentence that only looks like the wake word is not one", () => {
    // "sidenote" is two characters from "sidetone" and nothing like it in sound
    expect(afterWakeWord("side note, mute", WAKE, DEFAULTS.wakeWordVariants)).toBeNull();
    expect(afterWakeWord("set that aside and mute", WAKE, DEFAULTS.wakeWordVariants)).toBeNull();
  });
  test("9.1 the command starts with the wake word, so a late one does not count", () => {
    expect(afterWakeWord("I was going to say sidetone mute", WAKE)).toBeNull();
  });
});

describe("what the engine actually writes (9.3, 18.8)", () => {
  test("a form the engine produces is accepted as the wake word", () => {
    // small.en writes "sidetone" as "Side tone" a third of the time, and as
    // "Cytone", "Sigh tone" or "Sight tone" when the /d/ goes under the noise
    expect(afterWakeWord("Side tone, say that again.", WAKE)).toBeNull();
    expect(afterWakeWord("Side tone, say that again.", WAKE, DEFAULTS.wakeWordVariants)).toBe("say that again");
    for (const said of ["Cytone mute.", "Sigh tone, mute.", "Sight-tone mute.", "Sitone mute.", "side-tone mute."]) {
      expect(match(said, WAKE, false, MUTED, DEFAULTS.wakeWordVariants)).toEqual({ kind: "command", name: "mute" });
    }
  });
  test("a variant still has to come at the start", () => {
    expect(afterWakeWord("I heard a side tone for a while", WAKE, DEFAULTS.wakeWordVariants)).toBeNull();
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
    expect(match("sidetone do the thing", WAKE, false, MUTED)).toEqual({ kind: "unclear" });
  });
});

describe("muted (9.5, 9.6)", () => {
  test("only the commands in the setting work while muted", () => {
    expect(match("sidetone unmute", WAKE, true, MUTED)).toEqual({ kind: "command", name: "unmute" });
    expect(match("sidetone mute", WAKE, true, MUTED)).toEqual({ kind: "command", name: "mute" });
    expect(match("sidetone report the usage", WAKE, true, MUTED)).toEqual({ kind: "unclear" });
  });
  test("the set is a list, so it grows without a change to the code", () => {
    expect(match("sidetone report the usage", WAKE, true, [...MUTED, "usage"])).toEqual({ kind: "command", name: "usage" });
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
  test("9.3 \"end the turn\" elides to \"in the turn\", and every engine writes it that way", () => {
    // five whisper configurations, two voices, five noise levels: all of them
    // heard "in the turn". It was the only phrase any of them got wrong.
    expect(commandIn("in the turn")).toBe("endTurn");
    expect(commandIn("end the turn")).toBe("endTurn");
  });
  test("one word ends the turn, and \"sharp\" does not steal a word Chris says", () => {
    expect(commandIn("sharp")).toBe("endTurn");
    expect(commandIn("cancel")).toBe("endTurn");
    expect(commandIn("nevermind")).toBe("endTurn");
    // the price of a five letter word: one character of tolerance takes
    // "share" and "shard" with it. Both are words, and neither is one Chris
    // says straight after the wake word, which is the only place this runs.
    expect(commandIn("share")).toBe("endTurn");
    expect(commandIn("start")).toBe(null);
  });
  test("11.9 the rest of an answer, and the two ways to treat a question", () => {
    expect(commandIn("carry on")).toBe("carryOn");
    expect(commandIn("go on")).toBe("carryOn");
    expect(commandIn("continue")).toBe("carryOn");
    expect(commandIn("say the rest")).toBe("carryOn");
    // the explicit forms first: "interrupt" is inside "interrupt off"
    expect(commandIn("interrupt off")).toBe("interruptOff");
    expect(commandIn("interrupt on")).toBe("interruptOn");
    expect(commandIn("interrupt")).toBe("interrupt");
    expect(commandIn("barge in")).toBe("interrupt");
    // and none of them takes a command that was already there
    expect(commandIn("tones on")).toBe("tonesOn");
    expect(commandIn("end the turn")).toBe("endTurn");
    expect(commandIn("clear")).toBe("clearContext");
  });
  test("the new words do not steal an older command", () => {
    expect(commandIn("mute")).toBe("mute");
    expect(commandIn("stop")).toBe("endTurn");
    expect(commandIn("end the turn")).toBe("endTurn");
    expect(commandIn("unmute")).toBe("unmute");
    expect(commandIn("report the usage")).toBe("usage");
  });
  test("9.5 the tones can be silenced while muted, and the reports cannot", () => {
    expect(match("sidetone tones off", WAKE, true, MUTED)).toEqual({ kind: "command", name: "tonesOff" });
    expect(match("sidetone stats", WAKE, true, MUTED)).toEqual({ kind: "unclear" });
    expect(match("sidetone stats", WAKE, false, MUTED)).toEqual({ kind: "command", name: "stats" });
  });
});

describe("the hold music commands (15.7.3)", () => {
  test("the explicit forms reach their own command", () => {
    expect(commandIn("music off")).toBe("musicOff");
    expect(commandIn("turn the music off")).toBe("musicOff");
    expect(commandIn("music on")).toBe("musicOn");
    expect(commandIn("hold music on")).toBe("musicOn");
  });
  test("they do not take a command that was already there, and none takes them", () => {
    expect(commandIn("stop")).toBe("endTurn");
    expect(commandIn("sharp")).toBe("endTurn");
    expect(commandIn("mute")).toBe("mute");
    expect(commandIn("unmute")).toBe("unmute");
    expect(commandIn("tones off")).toBe("tonesOff");
    expect(commandIn("tones on")).toBe("tonesOn");
    expect(commandIn("interrupt on")).toBe("interruptOn");
    // "music" alone is not enough: it needs the word for the direction
    expect(commandIn("music")).toBe(null);
  });
  test("they do not work while muted, which is the setting's default", () => {
    expect(match("sidetone music off", WAKE, true, MUTED)).toEqual({ kind: "unclear" });
    expect(match("sidetone music off", WAKE, false, MUTED)).toEqual({ kind: "command", name: "musicOff" });
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

describe("a wake word run into its command (9.3)", () => {
  test("the engine writes it as one token, and it is still a command", () => {
    // observed: the first thing said on 14 September, which cost a turn
    expect(afterWakeWord("Sidetonemute.", WAKE)).toBe("mute");
    expect(commandIn(afterWakeWord("Sidetonemute.", WAKE) as string)).toBe("mute");
    expect(afterWakeWord("sidetonestats", WAKE)).toBe("stats");
  });

  test("only an exact prefix splits, or half the language becomes a wake word", () => {
    // one character out from "sidetone" and then a word: not a split
    expect(afterWakeWord("sidetonemute", WAKE)).toBe("mute");
    expect(afterWakeWord("sitetonemute", WAKE)).toBeNull();
    // and a sentence that merely starts similarly is still speech
    expect(afterWakeWord("the sidewalk is done", WAKE)).toBeNull();
  });

  test("stats keeps the spellings that have actually been heard", () => {
    for (const said of ["stats", "stets", "steph", "status"]) expect(commandIn(said)).toBe("stats");
    // "that's" is a word Chris says, so it is deliberately not one of them
    expect(commandIn("thats wrong")).not.toBe("stats");
  });
});
