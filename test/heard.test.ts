import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/heard.json";
import { match, type CommandName } from "../src/commands.ts";
import { DEFAULTS } from "../src/config.ts";

/**
 * 9.3 the bridge matches the sound of a command, not its spelling, because a
 * speech engine does not give back the word that was said. This is the record
 * of what it actually gave back: every phrase spoken by two voices, clean and
 * in brown noise at 10, 0 and -5 dB, read by the model that ships.
 *
 * A command that only works when the engine spells it the expected way is a
 * command that works at a desk and fails in a car. Both of the ones that did
 * fail in a car -- "male voice" heard as "Mail Voice", "end the turn" as "in
 * the turn" -- are in here now.
 *
 * Regenerate with scripts/heard-refresh.ts after adding a command.
 */
const phrases = fixture.phrases as Array<{ said: string; want: string | null; heard: string[] }>;

function reached(heard: string): string {
  const got = match(heard, DEFAULTS.wakeWord, false, DEFAULTS.mutedCommands, DEFAULTS.wakeWordVariants);
  return got.kind === "command" ? got.name : got.kind;
}

describe("what the engine wrote, and what the bridge made of it (9.3)", () => {
  for (const phrase of phrases) {
    const want = phrase.want ?? "speech";
    test(`"${phrase.said}" reaches ${want}, however it is written`, () => {
      expect(phrase.heard.length).toBeGreaterThan(0);
      for (const heard of phrase.heard) {
        expect(`${heard} -> ${reached(heard)}`).toBe(`${heard} -> ${want}`);
      }
    });
  }
});

describe("the corpus covers what it claims to", () => {
  test("every command has a phrase, so a new one cannot ship unheard", () => {
    const covered = new Set(phrases.map((p) => p.want).filter(Boolean));
    const all: CommandName[] = [
      "mute", "unmute", "clearContext", "usage", "restate", "summarize", "where",
      "endTurn", "tones", "tonesOn", "tonesOff", "stats", "femaleVoice", "maleVoice",
    ];
    expect(all.filter((name) => !covered.has(name))).toEqual([]);
  });

  test("the fixture is evidence, not the phrase list written twice", () => {
    // a long distinctive sentence comes back the same way every time, which is
    // the result we want. What would be wrong is a corpus with no variation at
    // all in it, meaning nobody ever ran it against noise.
    const varied = phrases.filter((p) => p.heard.length > 1).length;
    expect(varied).toBeGreaterThan(phrases.length / 2);
  });
});
