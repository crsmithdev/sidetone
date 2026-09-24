import { describe, expect, test } from "bun:test";
import { readDevice } from "../src/device.ts";

/** 14.15 what the phone says about itself as it joins the room. */
describe("the phone's device message (14.15)", () => {
  const served = "a".repeat(64);
  const phone = { kind: "device", model: "Pixel 8", aec: true, canceller: "software", route: "Bluetooth A2DP (SYNC)" };

  test("the build the bridge serves is named as that", () => {
    const { event, line } = readDevice({ ...phone, apk: served }, served, 1);
    expect(event).toEqual({ kind: "device", at: 1, model: "Pixel 8", aec: true, canceller: "software", route: "Bluetooth A2DP (SYNC)", apk: served, same: true });
    expect(line).toBe("the phone is a Pixel 8: software echo canceller (hardware available), route Bluetooth A2DP (SYNC), build aaaaaaaaaaaa, the build the bridge serves");
  });

  test("another build is named as not the one the bridge serves, with the one it serves", () => {
    const { event, line } = readDevice({ ...phone, apk: "b".repeat(64) }, served);
    expect(event?.same).toBe(false);
    expect(line).toEndWith("build bbbbbbbbbbbb, not the build the bridge serves (aaaaaaaaaaaa)");
  });

  test("the hashes compare whatever the case of their letters", () => {
    expect(readDevice({ ...phone, apk: served.toUpperCase() }, served).event?.same).toBe(true);
  });

  test("with no build served, or none named, the comparison is unknown", () => {
    expect(readDevice({ ...phone, apk: served }, undefined).line).toEndWith("the bridge serves no build");
    const { event, line } = readDevice(phone, served);
    expect(event?.same).toBeNull();
    expect(line).toEndWith("build unknown");
  });

  test("a message that is not readable goes in the journal and not the record", () => {
    for (const bad of [{ kind: "device" }, { ...phone, canceller: "both" }, { ...phone, aec: "yes" }, { ...phone, apk: 7 }]) {
      expect(readDevice(bad, served)).toEqual({ event: null, line: "a device message from the phone was not readable" });
    }
  });
});

/** 18.15 the setup in force on the phone, and whether the bridge pushed it. */
describe("the setup the phone runs with (14.15, 18.15)", () => {
  const phone = { kind: "device", model: "Pixel 8", aec: true, canceller: "software", route: "speaker" };
  const setup = { mode: "normal", output: "media", focus: "none", canceller: "software", noiseSuppression: true, autoGainControl: true };

  test("a pushed setup is named in the record and the journal", () => {
    const { event, line } = readDevice({ ...phone, setup, pushed: true }, undefined);
    expect(event).toMatchObject({ setup, pushed: true });
    expect(line).toEndWith("build unknown, setup normal mode, media output, no focus, software canceller, noise suppression on, auto gain control on, pushed");
  });

  test("the setup in the code is named as that", () => {
    const { event, line } = readDevice({ ...phone, setup: { ...setup, mode: "call" }, pushed: false }, undefined);
    expect(event?.pushed).toBe(false);
    expect(line).toEndWith("call mode, media output, no focus, software canceller, noise suppression on, auto gain control on, the one in the code");
  });

  test("an app from before the setup message names none, and the record has none", () => {
    const { event, line } = readDevice(phone, undefined);
    expect(event).not.toHaveProperty("setup");
    expect(event).not.toHaveProperty("pushed");
    expect(line).toEndWith("build unknown");
  });

  test("a setup with a name the bridge does not know is not readable", () => {
    for (const bad of [{ ...phone, setup: { ...setup, focus: "transient" }, pushed: false }, { ...phone, setup, pushed: "yes" }, { ...phone, setup }]) {
      expect(readDevice(bad, undefined).event).toBeNull();
    }
  });
});
