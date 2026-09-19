import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULTS, loadConfig, saveSettings, settingsInForce } from "../src/config.ts";

const dir = mkdtempSync(join(tmpdir(), "vb-config-"));
function withFile(body: string): string {
  const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, body);
  return path;
}

describe("config (21)", () => {
  test("no file means the spec defaults", () => {
    expect(loadConfig(join(dir, "missing.json"))).toEqual(DEFAULTS);
  });
  test("the defaults are the values the spec settles on", () => {
    expect(DEFAULTS.silenceMs).toBe(60_000);
    expect(DEFAULTS.ceilingMs).toBe(600_000);
    expect(DEFAULTS.checkpointWindowMs).toBe(15_000);
    expect(DEFAULTS.graceMs).toBe(30_000);
    expect(DEFAULTS.model).toBe("sonnet");
    expect(DEFAULTS.wakeWord).toBe("hey bridge");
    expect(DEFAULTS.agreementWord).toBe("continue");
    // 9.6 the set is a setting, and the tones are on it: you mute because the
    // car is loud, and the tones are the next noise you want gone.
    expect(DEFAULTS.mutedCommands).toEqual(["mute", "unmute", "tones", "tonesOn", "tonesOff"]);
  });
  test("a file overrides field by field", () => {
    const config = loadConfig(withFile('{"model":"opus","ceilingMs":60000}'));
    expect(config.model).toBe("opus");
    expect(config.ceilingMs).toBe(60_000);
    expect(config.silenceMs).toBe(DEFAULTS.silenceMs);
  });
  test('the agreement word can never be "yes" (10.2)', () => {
    expect(() => loadConfig(withFile('{"agreementWord":"yes"}'))).toThrow(/must not be "yes"/);
    expect(() => loadConfig(withFile('{"agreementWord":"Yes"}'))).toThrow(/must not be "yes"/);
    expect(loadConfig(withFile('{"agreementWord":"proceed"}')).agreementWord).toBe("proceed");
  });
  test("a timer that is not a positive number is refused, not silently defaulted", () => {
    expect(() => loadConfig(withFile('{"silenceMs":0}'))).toThrow(/positive number/);
    expect(() => loadConfig(withFile('{"ceilingMs":"ten"}'))).toThrow(/positive number/);
  });
  test("a broken file is an error, not a silent fallback", () => {
    expect(() => loadConfig(withFile("{oops"))).toThrow(/not valid JSON/);
    expect(() => loadConfig(withFile("[]"))).toThrow(/must hold an object/);
  });
});

/**
 * 19 September: the file said kokoro and left the voices alone, the defaults
 * were chatterbox's, and "hey bridge, male voice" asked kokoro for a wav it
 * does not have. The fake phone died the same way on its first line.
 */
describe("each engine names its own voices (4.9)", () => {
  test("a file that names the engine and not the voices gets that engine's", () => {
    const config = loadConfig(withFile('{"ttsEngine":"kokoro"}'));
    expect(config.ttsVoice).toBe("bf_emma");
    expect(config.voiceChoices).toEqual({ female: "bf_emma", male: "bm_george" });
  });
  test("a file that names the voices keeps them, whatever the engine", () => {
    const config = loadConfig(withFile('{"ttsEngine":"kokoro","ttsVoice":"af_heart","voiceChoices":{"female":"af_heart","male":"am_adam"}}'));
    expect(config.ttsVoice).toBe("af_heart");
    expect(config.voiceChoices).toEqual({ female: "af_heart", male: "am_adam" });
  });
  test("an engine that does not exist is refused, not run", () => {
    expect(() => loadConfig(withFile('{"ttsEngine":"espeak"}'))).toThrow(/ttsEngine must be one of/);
  });
});

describe("a setting changed out loud is kept (9.4)", () => {
  test("it lands in the file beside what was already set, and nothing else", () => {
    const path = withFile('{"model":"opus"}');
    saveSettings({ interruptOnSpeech: true }, path);
    saveSettings({ tones: false }, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ model: "opus", interruptOnSpeech: true, tones: false });
    expect(loadConfig(path).interruptOnSpeech).toBe(true);
  });
  test("with no file yet, the file is the patch", () => {
    const path = join(dir, "fresh.json");
    saveSettings({ ttsVoice: "bm_george" }, path);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ttsVoice: "bm_george" });
  });
});

describe("settings that arrive already checked", () => {
  const write = (values: Record<string, unknown>): string => {
    const path = join(tmpdir(), `voice-bridge-config-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(path, JSON.stringify(values));
    return path;
  };

  test("a barge-in quieter than speech is refused, not obeyed", () => {
    // 11.3 the wrong way round makes every recording a barge-in, which arrives
    // as "it keeps cutting me off" rather than as an error
    expect(() => loadConfig(write({ bargeInLevel: 0.01, speechLevel: 0.02 }))).toThrow(/bargeInLevel/);
    expect(() => loadConfig(write({ bargeInMs: 40, speechOnsetMs: 50 }))).toThrow(/bargeInMs/);
  });

  test("an invention guard under the speech level is refused", () => {
    expect(() => loadConfig(write({ minSpeechPeak: 0.01 }))).toThrow(/minSpeechPeak/);
  });

  test("a typo in the muted set is refused, not silently dropped", () => {
    // 9.6 it used to be a list of strings: "tonesoff" simply never matched
    expect(() => loadConfig(write({ mutedCommands: ["mute", "tonesoff"] }))).toThrow(/tonesoff/);
    expect(loadConfig(write({ mutedCommands: ["mute", "tonesOff"] })).mutedCommands).toEqual(["mute", "tonesOff"]);
  });

  test("every setting the voice path reads is in the record", () => {
    const kept = Object.keys(settingsInForce(DEFAULTS));
    for (const key of ["holdBackstopMs", "listenSettleMs", "sentenceMaxChars", "audioCueDelayMs", "audioCueEveryMs", "minSpeechPeak"]) {
      expect(kept).toContain(key);
    }
    // the list names real settings, and the defaults answer for each of them
    for (const key of kept) expect(DEFAULTS[key as keyof typeof DEFAULTS]).toBeDefined();
  });
});
