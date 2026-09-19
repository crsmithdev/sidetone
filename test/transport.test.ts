import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav } from "../src/audio.ts";
import { RTC_RATE, frameAt, resample, roomSpeaker, tokenFor, uniqueIdentity, type Player } from "../src/transport.ts";

/**
 * The pure half of the transport. These two functions carry the fault that
 * cost the most to find: the bridge published near-silence for a whole session
 * and everything upstream looked healthy, because a wav from piper opens
 * quietly and the failure arrives as quiet rather than as a stutter.
 *
 * The same tests exist in the caller repository against a copy of frameAt.
 * They are here because this is where the function ships.
 */
describe("resample", () => {
  test("returns the same array when the rate matches, rather than copying", () => {
    const samples = new Int16Array([1, 2, 3]);
    expect(resample(samples, RTC_RATE, RTC_RATE)).toBe(samples);
  });

  test("stretches 22 kHz up to 48", () => {
    const out = resample(new Int16Array([1, 2, 3, 4]), 22_050, RTC_RATE);
    expect(out.length).toBe(Math.round((4 * RTC_RATE) / 22_050));
    expect(out[0]).toBe(1);
  });

  test("a constant stays constant, so nothing is invented between samples", () => {
    const flat = new Int16Array(64).fill(1234);
    for (const sample of resample(flat, 22_050, RTC_RATE)) expect(sample).toBe(1234);
  });
});

describe("frameAt", () => {
  test("copies, so a frame is not a view onto the start of the buffer", () => {
    const samples = new Int16Array([1, 2, 3, 4, 5, 6]);
    const second = frameAt(samples, 2, 2);
    expect([...second]).toEqual([3, 4]);
    // AudioFrame reads the underlying buffer and ignores the view's offset, so
    // a subarray here sends the first frame over and over for a whole sentence
    expect(second.byteOffset).toBe(0);
    expect(second.buffer).not.toBe(samples.buffer);
  });

  test("pads the last short frame with silence", () => {
    expect([...frameAt(new Int16Array([1, 2, 3]), 2, 4)]).toEqual([3, 0, 0, 0]);
  });

  test("every frame of a ramp is the slice it names", () => {
    const ramp = new Int16Array(100);
    for (let i = 0; i < ramp.length; i++) ramp[i] = i;
    for (let at = 0; at < 100; at += 10) {
      expect([...frameAt(ramp, at, 10)]).toEqual([...ramp.slice(at, at + 10)]);
    }
  });
});

describe("the token a phone is given (12.2)", () => {
  const keys = { url: "ws://127.0.0.1:7880", apiKey: "devkey", apiSecret: "a-secret-long-enough-to-sign-with" };
  const payload = (jwt: string) => JSON.parse(atob((jwt.split(".")[1] as string).replace(/-/g, "+").replace(/_/g, "/")));

  test("it names the room and the identity it was minted for", async () => {
    const claims = payload(await tokenFor(keys, "bridge", "phone-1", 24));
    expect(claims.video.room).toBe("bridge");
    expect(claims.sub).toBe("phone-1");
  });

  test("it grants exactly what a phone needs and nothing more", async () => {
    const claims = payload(await tokenFor(keys, "bridge", "phone-1", 24)).video;
    expect(claims.roomJoin).toBe(true);
    expect(claims.canPublish).toBe(true);
    expect(claims.canSubscribe).toBe(true);
    expect(claims.canPublishData).toBe(true);
    // the ones never asked for stay absent rather than false by accident
    expect(claims.roomCreate).toBeUndefined();
    expect(claims.roomAdmin).toBeUndefined();
    expect(claims.roomList).toBeUndefined();
  });

  test("the hours asked for are the hours it lasts", async () => {
    const claims = payload(await tokenFor(keys, "bridge", "phone-1", 30 * 24));
    // the SDK stamps nbf and exp, and no iat
    const days = (claims.exp - claims.nbf) / 86_400;
    expect(days).toBeGreaterThan(29.9);
    expect(days).toBeLessThan(30.1);
  });
});

describe("the identity the bridge joins under", () => {
  test("it differs every time, or a restart evicts itself", () => {
    const seen = new Set(Array.from({ length: 200 }, () => uniqueIdentity()));
    expect(seen.size).toBe(200);
  });

  test("it still says what it is, for a log that has to be read", () => {
    expect(uniqueIdentity()).toStartWith("bridge-");
  });
});

/**
 * 7.4 the room's speaker, over a player that writes down what it was asked.
 * The literal in serve() that this replaces was never run under a test.
 */
describe("the room's speaker", () => {
  function player(whole = true, speaking = false) {
    const spoke: Array<{ bytes: number; until: (() => boolean) | undefined }> = [];
    const p: Player = {
      async speak(bytes, until) { spoke.push({ bytes: bytes.length, until }); return whole; },
      get speaking() { return speaking; },
    };
    return { p, spoke, quiet: () => { speaking = false; }, busy: () => { speaking = true; } };
  }
  function wav(): string {
    const path = join(mkdtempSync(join(tmpdir(), "speaker-")), "one.wav");
    Bun.write(path, encodeWav(new Int16Array(160), 16_000));
    return path;
  }
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  test("a sentence is journaled, then played with the cut the mouth gave it", async () => {
    const { p, spoke } = player();
    const said: string[] = [];
    const cut = () => false;
    const whole = await roomSpeaker(p, (line) => said.push(line)).play("Four.", wav(), cut);
    expect(whole).toBe(true);
    expect(said).toEqual(["  Four."]);
    expect(spoke).toHaveLength(1);
    expect(spoke[0]?.until).toBe(cut);
  });

  test("a sentence cut short says so, and the voice off plays nothing", async () => {
    const { p, spoke } = player(false);
    const said: string[] = [];
    const speaker = roomSpeaker(p, (line) => said.push(line));
    expect(await speaker.play("Four.", wav(), () => true)).toBe(false);
    expect(said).toEqual(["  Four.", "  [stopped: Chris started talking]"]);
    expect(await speaker.play("Five.", null, () => false)).toBe(true);
    expect(spoke).toHaveLength(1);
  });

  test("a cue is dropped when a sentence began while its file was read, and a missing file is not a crash", async () => {
    const { p, spoke, busy } = player();
    const said: string[] = [];
    const speaker = roomSpeaker(p, (line) => said.push(line));
    speaker.cue(wav(), () => false);
    await settle();
    expect(spoke).toHaveLength(1);
    busy();
    speaker.cue(wav(), () => false);
    await settle();
    expect(spoke).toHaveLength(1);
    speaker.cue("/nowhere/heard.wav", () => false);
    await settle();
    expect(said.some((line) => line.startsWith("[the cue failed:"))).toBe(true);
  });
});
