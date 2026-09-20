import { describe, expect, test } from "bun:test";
import fixture from "./fixtures/heard.json";
import { COMMAND_NAMES, match } from "../src/commands.ts";
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

/**
 * "sidetone" is one word, and at -5 dB the engine sometimes hears another
 * one: "so I don't", "Sitem". Those are recorded here and not reachable
 * without a variant that would fire on ordinary speech. The corpus of 20
 * September has 93 spellings and 5 such misses, 4 of them on the run-together
 * phrase, which is spoken with no pause at all. The rule is: ordinary speech
 * never wakes it, every command reaches its name in at least half of its
 * spellings, and the misses are counted, so a change that adds one shows up.
 */
const MISSES_ALLOWED = 5;

describe("what the engine wrote, and what the bridge made of it (9.3)", () => {
  for (const phrase of phrases) {
    const want = phrase.want ?? "speech";
    test(`"${phrase.said}" reaches ${want} in at least half its spellings`, () => {
      expect(phrase.heard.length).toBeGreaterThan(0);
      const got = phrase.heard.map((heard) => `${heard} -> ${reached(heard)}`);
      const right = got.filter((line) => line.endsWith(`-> ${want}`));
      if (want === "speech") expect(got).toEqual(phrase.heard.map((heard) => `${heard} -> speech`));
      else expect(right.length * 2).toBeGreaterThanOrEqual(got.length);
    });
  }
  test("the misses are counted", () => {
    const missed = phrases.flatMap((p) => p.heard.filter((heard) => reached(heard) !== (p.want ?? "speech")));
    expect(missed.length).toBeLessThanOrEqual(MISSES_ALLOWED);
  });
});

describe("the corpus covers what it claims to", () => {
  test("every command has a phrase, so a new one cannot ship unheard", () => {
    const covered = new Set(phrases.map((p) => p.want).filter(Boolean));
    // the list is the table's, not a copy of it: a copy missed four commands
    expect(COMMAND_NAMES.filter((name) => !covered.has(name))).toEqual([]);
  });

  test("the fixture is evidence, not the phrase list written twice", () => {
    // a long distinctive sentence comes back the same way every time, which is
    // the result we want. What would be wrong is a corpus with no variation at
    // all in it, meaning nobody ever ran it against noise.
    const varied = phrases.filter((p) => p.heard.length > 1).length;
    expect(varied).toBeGreaterThan(phrases.length / 2);
  });
});
