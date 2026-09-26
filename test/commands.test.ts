import { describe, expect, test } from "bun:test";
import { DEFAULTS } from "../src/config.ts";
import { afterWakeWord, commandIn, match, read } from "../src/commands.ts";

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
    expect(commandIn("say the rest")).toBe("carryOn");
    // the explicit forms first: "interrupt" is inside "interrupt off"
    expect(commandIn("interrupt off")).toBe("interruptOff");
    expect(commandIn("interrupt on")).toBe("interruptOn");
    // and none of them takes a command that was already there
    expect(commandIn("tones on")).toBe("tonesOn");
    expect(commandIn("end the turn")).toBe("endTurn");
    expect(commandIn("clear context")).toBe("clearContext");
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

describe("an utterance, read once (9.1, 9.5, 10.2)", () => {
  test("inside the wake-word hold a short utterance is the command, and a long one is speech", () => {
    expect(read("Mute.", DEFAULTS, false, true)).toEqual({ kind: "command", name: "mute", agreed: false });
    expect(read("Mute.", DEFAULTS, false, false)).toEqual({ kind: "speech", agreed: false });
    expect(read("how do i stop the server", DEFAULTS, false, true)).toEqual({ kind: "speech", agreed: false });
  });
  test("the muted rule holds inside the wake-word hold too", () => {
    expect(read("stats", DEFAULTS, true, true)).toEqual({ kind: "speech", agreed: false });
    expect(read("unmute", DEFAULTS, true, true)).toEqual({ kind: "command", name: "unmute", agreed: false });
    expect(read("sidetone stats", DEFAULTS, true, false)).toEqual({ kind: "unclear", agreed: false });
  });
  test("the agreement word agrees alone, or with only a plain yes or the wake word beside it", () => {
    expect(read("Continue.", DEFAULTS, false, false)).toEqual({ kind: "speech", agreed: true });
    for (const said of ["continue", "Continue,", "CONTINUE!", "Okay, continue.", "OK continue", "Yes, continue.", "Yeah continue",
      "Continue, please.", "Sure, continue.", "Go ahead, continue.", "Yes please, continue.", "Side tone, continue.", "Continue, sidetone."]) {
      expect(read(said, DEFAULTS, false, false).agreed).toBe(true);
    }
    expect(read("yes go on", DEFAULTS, false, false).agreed).toBe(false);
  });
  test("anything else beside the agreement word, a negation first of all, does not agree", () => {
    for (const said of ["do not continue", "Don't continue.", "no, don't continue", "no continue", "not continue", "continue later",
      "can we continue later", "I want to continue the refactor", "continue with the tests", "okay", "yes", "continue continue"]) {
      expect(read(said, DEFAULTS, false, false).agreed).toBe(false);
    }
  });
  test("the rule is built from the setting, not from the word continue", () => {
    const proceed = { ...DEFAULTS, agreementWord: "proceed" };
    expect(read("Okay, proceed.", proceed, false, false).agreed).toBe(true);
    expect(read("don't proceed", proceed, false, false).agreed).toBe(false);
    expect(read("continue", proceed, false, false).agreed).toBe(false);
  });
});

describe("the verbosity commands (item 37)", () => {
  test("each level has its own command, and one level either way has a word", () => {
    expect(commandIn("verbosity brief")).toBe("verbosityBrief");
    expect(commandIn("verbosity normal")).toBe("verbosityNormal");
    expect(commandIn("verbosity full")).toBe("verbosityFull");
    expect(commandIn("shorter")).toBe("shorter");
    expect(commandIn("longer")).toBe("longer");
    // "verbosity" alone names no level
    expect(commandIn("verbosity")).toBe(null);
  });
  test("they do not take a command that was already there", () => {
    expect(commandIn("stop")).toBe("endTurn");
    expect(commandIn("mute")).toBe("mute");
    expect(commandIn("tones on")).toBe("tonesOn");
    expect(commandIn("say that again")).toBe("restate");
  });
  test("they do not work while muted, which is the setting's default", () => {
    expect(match("sidetone shorter", WAKE, true, MUTED)).toEqual({ kind: "unclear" });
    expect(match("sidetone shorter", WAKE, false, MUTED)).toEqual({ kind: "command", name: "shorter" });
  });
});

describe("the wake-word review (item 36)", () => {
  test("summarize is gone: where and the verbosity cover it", () => {
    expect(commandIn("summarize")).toBe(null);
    expect(commandIn("summarize the last answer")).toBe(null);
    expect(commandIn("summary")).toBe(null);
  });
  test("the bare tones and the bare interrupt are gone: each needs on or off", () => {
    for (const said of ["tones", "tone", "chimes", "interrupt", "interrupting", "barge in"]) {
      expect(commandIn(said)).toBe(null);
    }
    expect(match("sidetone tones", WAKE, false, MUTED)).toEqual({ kind: "unclear" });
    expect(match("sidetone interrupt", WAKE, false, MUTED)).toEqual({ kind: "unclear" });
    expect(commandIn("tones off")).toBe("tonesOff");
    expect(commandIn("interrupt on")).toBe("interruptOn");
  });
  test("clearing the context needs the two words, and \"clear\" alone clears nothing", () => {
    expect(commandIn("clear")).toBe(null);
    expect(commandIn("clear the screen")).toBe(null);
    expect(commandIn("clear context")).toBe("clearContext");
    expect(commandIn("clear the context")).toBe("clearContext");
    expect(read("clear", DEFAULTS, false, true)).toEqual({ kind: "speech", agreed: false });
  });
  test("\"continue\" is the agreement word only, and carry on keeps its other forms", () => {
    expect(commandIn("continue")).toBe(null);
    expect(read("sidetone continue", DEFAULTS, false, false)).toEqual({ kind: "unclear", agreed: true });
    for (const said of ["carry on", "go on", "say the rest"]) expect(commandIn(said)).toBe("carryOn");
  });
  test("the muted set names no command that is gone", () => {
    expect(MUTED).toEqual(["mute", "unmute", "tonesOn", "tonesOff"]);
  });
});

describe("the clashes the review found (item 36)", () => {
  test("\"turn the audio on\" turns the audio on: \"on\" is one character from \"in\", and \"in turn\" ends the turn", () => {
    expect(commandIn("turn the audio on")).toBe("audioOn");
    expect(commandIn("turn the music on")).toBe("musicOn");
    expect(commandIn("turn interrupt on")).toBe("interruptOn");
    expect(commandIn("turn the tones on")).toBe("tonesOn");
    expect(match("sidetone, turn the audio on", WAKE, false, MUTED)).toEqual({ kind: "command", name: "audioOn" });
    // and the turn still ends on the forms the engine writes
    expect(commandIn("in turn")).toBe("endTurn");
    expect(commandIn("and turn")).toBe("endTurn");
  });
  test("one spoken word stands for one word of a command: \"one\" is not \"tone\" and \"on\" at once", () => {
    expect(commandIn("one more")).toBe(null);
    expect(read("one more", DEFAULTS, false, true)).toEqual({ kind: "speech", agreed: false });
    expect(commandIn("tones on")).toBe("tonesOn");
    expect(commandIn("tone on")).toBe("tonesOn");
  });
  test("\"where\" alone reaches nothing: \"there\" and \"here\" are one character away, and it drops a held answer", () => {
    for (const said of ["there", "here", "were", "where"]) expect(commandIn(said)).toBe(null);
    expect(match("sidetone there", WAKE, false, MUTED)).toEqual({ kind: "unclear" });
    for (const said of ["over there", "is it there", "we were"]) {
      expect(read(said, DEFAULTS, false, true)).toEqual({ kind: "speech", agreed: false });
    }
    // the phrase of 9.4.7 and the two short forms still reach it
    for (const said of ["where are we", "report where we are", "recap", "catch up"]) expect(commandIn(said)).toBe("where");
  });
  test("\"man\" is gone from the male voice: \"can\" and \"mean\" are one character away", () => {
    expect(commandIn("what can I say")).toBe(null);
    expect(commandIn("use the man voice")).toBe(null);
    for (const said of ["yes I can", "I mean", "the man"]) {
      expect(read(said, DEFAULTS, false, true)).toEqual({ kind: "speech", agreed: false });
    }
    // the forms the engine writes stay
    expect(commandIn("male voice")).toBe("maleVoice");
    expect(commandIn("mail")).toBe("maleVoice");
  });
});

describe("the clashes the review found, the rest of the table (item 36)", () => {
  test("\"mute the music\" turns the music off, and \"mute\" alone still mutes", () => {
    expect(commandIn("mute the music")).toBe("musicOff");
    expect(match("sidetone, mute the music", WAKE, false, MUTED)).toEqual({ kind: "command", name: "musicOff" });
    expect(commandIn("mute")).toBe("mute");
    expect(commandIn("unmute")).toBe("unmute");
    expect(match("sidetone, mute the music", WAKE, true, MUTED)).toEqual({ kind: "unclear" });
  });
  test("in the wake-word hold, a word near a command word is speech: no wake word guards it", () => {
    for (const said of ["make it so", "the best", "go in", "turn it on"]) {
      expect(read(said, DEFAULTS, false, true)).toEqual({ kind: "speech", agreed: false });
    }
    // the exact forms still work in the hold, the forms the engine writes among them
    for (const [said, name] of [["male voice", "maleVoice"], ["mail", "maleVoice"], ["the rest", "carryOn"], ["go on", "carryOn"],
      ["in the turn", "endTurn"], ["steph", "stats"], ["tones off", "tonesOff"]] as const) {
      expect(read(said, DEFAULTS, false, true)).toEqual({ kind: "command", name, agreed: false });
    }
  });
});

describe("two words of a command run together (9.3)", () => {
  test("one word stands for two adjacent words of a form", () => {
    expect(commandIn("verbosityful")).toBe("verbosityFull");
    expect(commandIn("verbositynormal")).toBe("verbosityNormal");
    expect(commandIn("tonesoff")).toBe("tonesOff");
    expect(match("Sidetone, verbosityful.", WAKE, false, MUTED)).toEqual({ kind: "command", name: "verbosityFull" });
  });
  test("a joined word that is not a command stays unclear", () => {
    // "go on", "the rest" and "interrupt on" would take these with the forgiveness of one long word
    for (const said of ["sidetone good", "sidetone soon", "sidetone theres", "sidetone interruption", "sidetone interrupted", "sidetone sounds"]) {
      expect(match(said, WAKE, false, MUTED)).toEqual({ kind: "unclear" });
    }
    // and in the wake-word hold a joined word must be exact
    expect(read("verbosityful", DEFAULTS, false, true)).toEqual({ kind: "speech", agreed: false });
  });
});
