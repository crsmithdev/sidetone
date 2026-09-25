import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav } from "../src/audio.ts";
import { RoomEvent, TrackKind } from "@livekit/rtc-node";
import { Ear } from "../src/ear.ts";
import { Measures } from "../src/measures.ts";
import { RTC_RATE, Transport, fadeOut, frameAt, resample, roomSpeaker, tokenFor, uniqueIdentity, type Player } from "../src/transport.ts";
import type { Fade } from "../src/mouth.ts";

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
 * 14.15 a restart of the bridge does not end the phone's room. The SDK names
 * no arrival for a participant that was there first, so the phone went
 * ungreeted and never said what it is.
 */
describe("the clients the bridge is told of (14.8, 14.15)", () => {
  /** A room that holds `present` when the bridge connects, and keeps its handlers so a test can fire one. */
  function roomWith(present: string[]) {
    const handlers = new Map<string, (participant: { identity: string }) => void>();
    const transport = new Transport();
    (transport as unknown as { room: unknown }).room = {
      connect: async () => {},
      on: (event: string, handle: (participant: { identity: string }) => void) => { handlers.set(event, handle); },
      remoteParticipants: new Map(present.map((identity) => [identity, { identity }])),
    };
    return { transport, arrive: (identity: string) => handlers.get(RoomEvent.ParticipantConnected)?.({ identity }) };
  }

  test("one already in the room when the bridge connects is told of once", async () => {
    const { transport } = roomWith(["phone-1"]);
    const told: string[] = [];
    transport.onParticipant((identity) => told.push(identity));
    await transport.connect("ws://127.0.0.1:7880", "token");
    expect(told).toEqual(["phone-1"]);
  });

  test("one that arrives later is told of as it arrives", async () => {
    const { transport, arrive } = roomWith([]);
    const told: string[] = [];
    transport.onParticipant((identity) => told.push(identity));
    await transport.connect("ws://127.0.0.1:7880", "token");
    arrive("phone-1");
    expect(told).toEqual(["phone-1"]);
  });
});

/**
 * 7.4 the room's speaker, over a player that writes down what it was asked.
 * The literal in serve() that this replaces was never run under a test.
 */
describe("the room's speaker", () => {
  function player(whole = true, speaking = false) {
    const spoke: Array<{ bytes: number; until: (() => boolean) | undefined; fade: Fade | undefined }> = [];
    const p: Player = {
      async speak(bytes, until, fade) { spoke.push({ bytes: bytes.length, until, fade }); return whole; },
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

  test("a sentence cut short says so, and the audio off plays nothing", async () => {
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

  test("hold music plays with the cut it was given, and says how it ended (15.7)", async () => {
    const { p, spoke } = player();
    const said: string[] = [];
    const cut = () => false;
    const fade = { when: () => false, ms: 300 };
    expect(await roomSpeaker(p, (line) => said.push(line)).track(new Uint8Array(8), cut, fade)).toBe(true);
    expect(said).toEqual(["[hold music]", "[hold music ended]"]);
    expect(spoke[0]?.until).toBe(cut);
    expect(spoke[0]?.fade).toBe(fade);
    const stopped = player(false);
    said.length = 0;
    expect(await roomSpeaker(stopped.p, (line) => said.push(line)).track(new Uint8Array(8), () => true, fade)).toBe(false);
    expect(said).toEqual(["[hold music]", "[hold music stopped]"]);
  });

  test("hold music is refused, and nothing is played, while a sentence, a cue or a /play track has the source", () => {
    const { p, spoke, busy } = player();
    busy();
    expect(roomSpeaker(p, () => {}).track(new Uint8Array(8), () => false, { when: () => false, ms: 300 })).toBeNull();
    expect(spoke).toHaveLength(0);
  });
});

/**
 * 15.10.2 the hold music fades out when a sentence is due. The frames are
 * written to a source of the test's own, so the level of each one can be read.
 */
describe("the fade of the hold music (15.10.2)", () => {
  test("the level falls in a straight line from whole to nothing", () => {
    const frame = new Int16Array(4).fill(1_000);
    fadeOut(frame, 0, 8);
    expect([...frame]).toEqual([1_000, 875, 750, 625]);
    const rest = new Int16Array(4).fill(1_000);
    fadeOut(rest, 4, 8);
    expect([...rest]).toEqual([500, 375, 250, 125]);
  });

  test("past the end of the fade the frame is silent, never louder", () => {
    const frame = new Int16Array(3).fill(-1_000);
    fadeOut(frame, 10, 8);
    expect([...frame]).toEqual([0, 0, 0]);
  });

  /** One second of a steady level, written 20 ms at a time to a source that keeps the last sample of each frame. */
  async function written(fade: { when: () => boolean; ms: number } | undefined, until?: () => boolean) {
    const transport = new Transport();
    const levels: number[] = [];
    (transport as unknown as { source: unknown }).source = {
      captureFrame: async (frame: { data: Int16Array }) => { levels.push(frame.data.at(-1) as number); },
      clearQueue: () => {},
    };
    const whole = await transport.speak(encodeWav(new Int16Array(RTC_RATE).fill(10_000), RTC_RATE), until, fade);
    return { whole, levels };
  }

  test("the track plays at its own level until the fade is asked for, then fades over its time and ends", async () => {
    let asked = false;
    let frames = 0;
    const { whole, levels } = await written({ when: () => asked, ms: 300 }, () => { if (++frames === 11) asked = true; return false; });
    expect(whole).toBe(false);
    // 10 whole frames, then 15 frames of 20 ms make 300 ms
    expect(levels.slice(0, 10).every((level) => level === 10_000)).toBe(true);
    expect(levels).toHaveLength(10 + 15);
    expect(levels[10]).toBeLessThan(10_000);
    expect(levels[10]).toBeGreaterThan(9_000);
    expect(levels.at(-1)).toBeLessThan(1_000);
    for (let i = 11; i < levels.length; i++) expect(levels[i]).toBeLessThan(levels[i - 1] as number);
  });

  test("a fade of no time is a cut", async () => {
    const { whole, levels } = await written({ when: () => true, ms: 0 });
    expect(whole).toBe(false);
    expect(levels).toEqual([]);
  });

  test("a cut stops it at once, in the middle of a fade", async () => {
    let frames = 0;
    const { whole, levels } = await written({ when: () => true, ms: 300 }, () => ++frames > 3);
    expect(whole).toBe(false);
    expect(levels).toHaveLength(3);
  });

  test("with no fade asked for the track plays to its end", async () => {
    const { whole, levels } = await written({ when: () => false, ms: 300 });
    expect(whole).toBe(true);
    expect(levels).toHaveLength(50);
  });
});

/**
 * 11.3 and 11.12.2 the voice stops at once. The source is LiveKit's own, which
 * takes a second of frames ahead of what it has sent. The loop that writes the
 * frames stops within one frame of a cut; what the source already holds does
 * not stop with it, unless the cut clears it.
 */
describe("a cut stops the voice at once (11.3, 11.12.2)", () => {
  test("what the source holds after the cut is under half a second", async () => {
    const transport = new Transport();
    const source = (transport as unknown as { source: { queuedDuration: number } }).source;
    let frames = 0;
    // three seconds of a sentence, cut 800 ms in
    const whole = await transport.speak(encodeWav(new Int16Array(RTC_RATE * 3).fill(10_000), RTC_RATE), () => ++frames > 40);
    expect(whole).toBe(false);
    expect(source.queuedDuration).toBeLessThan(500);
  });
});

/**
 * 18.9.7 one microphone track per participant feeds the ear. On 23 September
 * a track outlived the app's cut and stayed in the room. Each later press
 * published a second track, and the dead one's silent frames went into the
 * same ear: every press gave a barge-in and no utterance.
 */
describe("one microphone track per participant (18.9.7)", () => {
  /** A track the test sends frames down, one at a time. */
  function track(sid: string) {
    const queued: Int16Array[] = [];
    let wake: (() => void) | null = null;
    return {
      sid,
      kind: TrackKind.KIND_AUDIO,
      send(data: Int16Array) { queued.push(data); wake?.(); },
      async *frames() {
        for (;;) {
          while (queued.length) yield { data: queued.shift() as Int16Array };
          await new Promise<void>((resolve) => { wake = resolve; });
        }
      },
    };
  }
  type Track = ReturnType<typeof track>;

  /** A room that holds `present` at the start, with a transport whose streams are the tracks' own. */
  function roomWith(present: Array<{ identity: string; tracks: Track[] }>) {
    const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    const participants = new Map(present.map(({ identity, tracks }) => [identity, {
      identity,
      trackPublications: new Map(tracks.map((t) => [t.sid, { track: t }])),
    }]));
    const transport = new Transport();
    (transport as unknown as { room: unknown }).room = {
      on: (event: string, handle: (...args: unknown[]) => void) => { handlers.set(event, [...(handlers.get(event) ?? []), handle]); },
      remoteParticipants: participants,
    };
    (transport as unknown as { stream: unknown }).stream = (t: Track) => t.frames();
    const fire = (event: string, t: Track, identity: string) => {
      for (const handle of handlers.get(event) ?? []) handle(t, { track: t }, { identity });
    };
    return {
      transport,
      publish: (t: Track, identity = "phone-1") => fire(RoomEvent.TrackSubscribed, t, identity),
      unpublish: (t: Track, identity = "phone-1") => fire(RoomEvent.TrackUnsubscribed, t, identity),
    };
  }

  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
  const RATE = 16_000;
  const frame = (level: number) => new Int16Array(RATE / 50).fill(Math.round(level * 32768));

  test("the case of 23 September: a dead track and a live one, and a press on the live one is heard", async () => {
    const dead = track("TR_AM7P3opgxRZtPh");
    const { transport, publish } = roomWith([{ identity: "phone-1", tracks: [dead] }]);
    const told: string[] = [];
    const lines: string[] = [];
    const ear = new Ear({
      isMuted: false,
      cue: () => {},
      stopSpeaking: () => told.push("stop"),
      heard: async (text) => { told.push(`heard ${text}`); },
      heardNothing: () => told.push("nothing"),
    }, async () => "right now", {
      sampleRate: RATE, endOfTurnPauseMs: 900, speechOnsetMs: 50, speechLevel: 0.02,
      bargeInLevel: 0.05, bargeInMs: 400, bargeInGapMs: 120, minSpeechPeak: 0.15, earlyTranscribeMs: 200,
    }, new Measures(), (line) => lines.push(line));
    transport.onAudio((f) => ear.frame(f), (line) => lines.push(line));
    const live = track("TR_AM4SMJBU3kPTqf");
    publish(live);
    expect(lines).toContain("[a newer microphone track from phone-1: TR_AM4SMJBU3kPTqf feeds the ear, TR_AM7P3opgxRZtPh no longer does]");
    ear.hold(true);
    // one second of speech on the live track, and a silent frame beside each one from the dead track
    for (let i = 0; i < 50; i++) {
      dead.send(frame(0));
      live.send(frame(0.4));
      await tick();
    }
    ear.reset(true);
    await tick();
    expect(told).toEqual(["stop", "heard right now"]);
  });

  test("when the newest track goes, the one before it feeds the ear again", async () => {
    const older = track("TR_a");
    const newer = track("TR_b");
    const { transport, publish, unpublish } = roomWith([]);
    const heard: number[] = [];
    const lines: string[] = [];
    transport.onAudio((f) => heard.push(f[0] as number), (line) => lines.push(line));
    publish(older);
    publish(newer);
    older.send(new Int16Array([1]));
    newer.send(new Int16Array([2]));
    await tick();
    unpublish(newer);
    older.send(new Int16Array([3]));
    await tick();
    expect(heard).toEqual([2, 3]);
    expect(lines).toEqual([
      "[a newer microphone track from phone-1: TR_b feeds the ear, TR_a no longer does]",
      "[TR_a from phone-1 feeds the ear again]",
    ]);
  });

  test("an older track that goes changes nothing and says nothing", async () => {
    const older = track("TR_a");
    const newer = track("TR_b");
    const { transport, publish, unpublish } = roomWith([]);
    const heard: number[] = [];
    const lines: string[] = [];
    transport.onAudio((f) => heard.push(f[0] as number), (line) => lines.push(line));
    publish(older);
    publish(newer);
    unpublish(older);
    newer.send(new Int16Array([2]));
    await tick();
    expect(heard).toEqual([2]);
    expect(lines).toHaveLength(1);
  });

  test("18.13.2 the microphone stays open while a track feeds the ear: the older of two goes", () => {
    const older = track("TR_a");
    const newer = track("TR_b");
    const { transport, publish, unpublish } = roomWith([]);
    const said: string[] = [];
    transport.onMicrophone((on, sid, open) => said.push(`${on ? "has" : "lost"} ${sid}, ${open ? "open" : "cut"}`));
    publish(older);
    publish(newer);
    unpublish(older);
    unpublish(newer);
    expect(said).toEqual(["has TR_a, open", "has TR_b, open", "lost TR_a, open", "lost TR_b, cut"]);
  });

  test("each participant has its own track, so two participants both feed the ear", async () => {
    const phone = track("TR_phone");
    const page = track("TR_page");
    const { transport, publish } = roomWith([]);
    const heard: number[] = [];
    const lines: string[] = [];
    transport.onAudio((f) => heard.push(f[0] as number), (line) => lines.push(line));
    publish(phone, "phone-1");
    publish(page, "page-1");
    phone.send(new Int16Array([1]));
    page.send(new Int16Array([2]));
    await tick();
    expect(heard.sort()).toEqual([1, 2]);
    expect(lines).toEqual([]);
  });
});
