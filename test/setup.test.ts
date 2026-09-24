import { describe, expect, test } from "bun:test";
import { readSetup, setupWords } from "../src/setup.ts";

/** 18.15 a setup the bridge pushes to the phone, in names rather than Android constants. */
describe("a pushed audio setup (18.15)", () => {
  const names = { mode: "normal", output: "media", focus: "none", canceller: "software", noiseSuppression: true, autoGainControl: false } as const;

  test("a setup is read from its names, and every name has to be one the app maps", () => {
    expect(readSetup(names)).toEqual({ kind: "setup", default: false, ...names });
    for (const bad of [
      { ...names, mode: "communication" },
      { ...names, output: "speech" },
      { ...names, focus: "transient" },
      { ...names, canceller: "webrtc" },
      { ...names, noiseSuppression: "on" },
      { ...names, autoGainControl: undefined },
      {},
    ]) {
      expect(readSetup(bad)).toBeNull();
    }
  });

  test("a default asks for the setup in the app's code, and carries no other field", () => {
    expect(readSetup({ default: true })).toEqual({ kind: "setup", default: true });
    // the other fields are not read, so a stale one cannot ride along
    expect(readSetup({ default: true, mode: "communication" })).toEqual({ kind: "setup", default: true });
    expect(readSetup({ default: false, ...names })).toEqual({ kind: "setup", default: false, ...names });
  });

  test("the words name the setup the way the journal does", () => {
    expect(setupWords({ kind: "setup", default: false, ...names })).toBe("normal mode, media output, no focus, software canceller, noise suppression on, auto gain control off");
    expect(setupWords({ kind: "setup", default: true })).toBe("the setup in the app's code");
  });
});
