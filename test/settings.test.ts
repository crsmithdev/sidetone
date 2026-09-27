import { describe, expect, test } from "bun:test";
import { DEFAULTS, type Config } from "../src/config.ts";
import { Settings } from "../src/settings.ts";

/** The settings in force over a fresh config, with every end written down. */
function made() {
  const values: Config = { ...DEFAULTS };
  const kept: Array<Partial<Config>> = [];
  const recorded: Array<Partial<Config>> = [];
  const sent: Array<Record<string, unknown>> = [];
  const journal: string[] = [];
  const settings = new Settings(values, {
    keep: (patch) => kept.push(patch),
    record: (patch) => recorded.push(patch),
    // what a client is sent is what is in force at the moment it is sent
    broadcast: () => sent.push({ ...values }),
    journal: (line) => journal.push(line),
  });
  return { values, settings, kept, recorded, sent, journal };
}

describe("one change to the settings in force (9.4, 9.4.9)", () => {
  test("a change is taken, kept for the next run, recorded, and sent to every client", () => {
    const s = made();
    expect(s.settings.change({ tones: false })).toBe(true);
    expect(s.values.tones).toBe(false);
    expect(s.settings.values.tones).toBe(false);
    expect(s.kept).toEqual([{ tones: false }]);
    expect(s.recorded).toEqual([{ tones: false }]);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.tones).toBe(false);
  });

  test("a change the file would refuse is not taken, kept or recorded, and the client is sent what is in force (item 44)", () => {
    const s = made();
    // 11.3 a barge-in no louder than speech
    expect(s.settings.change({ bargeInLevel: DEFAULTS.speechLevel })).toBe(false);
    expect(s.values.bargeInLevel).toBe(DEFAULTS.bargeInLevel);
    expect(s.kept).toEqual([]);
    expect(s.recorded).toEqual([]);
    expect(s.sent).toHaveLength(1);
    expect(s.sent[0]?.bargeInLevel).toBe(DEFAULTS.bargeInLevel);
    expect(s.journal).toHaveLength(1);
    expect(s.journal[0]).toStartWith(`refused bargeInLevel ${DEFAULTS.speechLevel}: bargeInLevel`);
  });

  test("a change is checked against the values in force, not the defaults", () => {
    const s = made();
    expect(s.settings.change({ speechLevel: 0.01 })).toBe(true);
    // 0.015 is louder than speech now, and would not have been before
    expect(s.settings.change({ bargeInLevel: 0.015 })).toBe(true);
    expect(s.values.bargeInLevel).toBe(0.015);
  });
});
