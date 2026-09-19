import { describe, expect, test } from "bun:test";
import { Utterances, decodeWav, encodeWav, level, tooQuiet, type Utterance } from "../src/audio.ts";

const RATE = 16_000;
/** 20 ms of frame, the size LiveKit hands over. */
function frame(amplitude: number, ms = 20): Int16Array {
  const out = new Int16Array((RATE * ms) / 1000);
  for (let i = 0; i < out.length; i++) out[i] = Math.round(Math.sin(i / 4) * amplitude * 32767);
  return out;
}
const LOUD = frame(0.3);
/** Over the level that opens a recording, under the level that stops the bridge. */
const NOISE = frame(0.03);
const QUIET = frame(0.0001);

function collector(tentativeMs?: number) {
  return new Utterances({
    sampleRate: RATE, endOfTurnPauseMs: 200, speechOnsetMs: 40, speechLevel: 0.02,
    bargeInLevel: 0.05, bargeInMs: 200, bargeInGapMs: 100, earlyTranscribeMs: tentativeMs,
  });
}

/** Push frames and collect what each one finished and what was offered early. */
function drive(u: Utterances, frames: Int16Array[]) {
  const done: Utterance[] = [];
  const early: Utterance[] = [];
  for (const f of frames) {
    const finished = u.push(f);
    const tentative = u.tentativeEnd();
    if (tentative) early.push(tentative);
    if (finished) done.push(finished);
  }
  return { done, early };
}

describe("the tentative end (18.4)", () => {
  test("the recording so far is offered once, at the tentative quiet, and the utterance that follows is its continuation", () => {
    const u = collector(100);
    const { done, early } = drive(u, [...Array(5).fill(LOUD), ...Array(10).fill(QUIET)]);
    expect(early).toHaveLength(1);
    expect(done).toHaveLength(1);
    // the same speech in both: nothing was said after the guess
    expect(early[0]?.speechMs).toBe(done[0]?.speechMs);
    expect(early[0]?.samples.length).toBeLessThan(done[0]?.samples.length ?? 0);
  });

  test("speech after the guess makes it wrong, and the next quiet is offered again", () => {
    const u = collector(100);
    const { done, early } = drive(u, [...Array(5).fill(LOUD), ...Array(5).fill(QUIET), ...Array(3).fill(LOUD), ...Array(10).fill(QUIET)]);
    expect(early).toHaveLength(2);
    expect(done).toHaveLength(1);
    expect(early[0]?.speechMs).toBeLessThan(done[0]?.speechMs ?? 0);
    expect(early[1]?.speechMs).toBe(done[0]?.speechMs);
  });

  test("without a setting nothing is offered", () => {
    const u = collector();
    const { early } = drive(u, [...Array(5).fill(LOUD), ...Array(10).fill(QUIET)]);
    expect(early).toEqual([]);
  });

  /**
   * The number that decides whether a turn detector is worth a drive: how
   * often a quiet as long as the tentative one was followed by more speech.
   * Each of those is a sentence a shorter pause would have cut in half.
   */
  test("a quiet that speech went on after is a false end; the last quiet is not; a breath is not", () => {
    const twice = collector(100);
    const { done } = drive(twice, [
      ...Array(5).fill(LOUD), ...Array(5).fill(QUIET), ...Array(3).fill(LOUD),
      ...Array(6).fill(QUIET), ...Array(3).fill(LOUD), ...Array(10).fill(QUIET),
    ]);
    expect(done[0]?.falseEnds).toBe(2);

    const breath = collector(100);
    expect(drive(breath, [...Array(5).fill(LOUD), ...Array(3).fill(QUIET), ...Array(3).fill(LOUD), ...Array(10).fill(QUIET)]).done[0]?.falseEnds).toBe(0);

    const unset = collector();
    expect(drive(unset, [...Array(5).fill(LOUD), ...Array(5).fill(QUIET), ...Array(3).fill(LOUD), ...Array(10).fill(QUIET)]).done[0]?.falseEnds).toBe(0);

    // the count belongs to one utterance
    expect(drive(twice, [...Array(5).fill(LOUD), ...Array(10).fill(QUIET)]).done[0]?.falseEnds).toBe(0);
  });
});

describe("wav", () => {
  test("what is written is what is read back", () => {
    const samples = new Int16Array([0, 1000, -1000, 32767, -32768]);
    const wav = decodeWav(encodeWav(samples, 22050));
    expect(wav.sampleRate).toBe(22050);
    expect(wav.channels).toBe(1);
    expect(Array.from(wav.samples)).toEqual(Array.from(samples));
  });
  test("a file that is not a wav is refused rather than misread", () => {
    expect(() => decodeWav(new Uint8Array(64))).toThrow("not a RIFF file");
  });
});

describe("level", () => {
  test("silence is nothing and speech is not", () => {
    expect(level(QUIET)).toBeLessThan(0.02);
    expect(level(LOUD)).toBeGreaterThan(0.02);
    expect(level(new Int16Array(0))).toBe(0);
  });
});

describe("utterances (11.5)", () => {
  test("a quiet room produces nothing at all", () => {
    const u = collector();
    for (let i = 0; i < 100; i++) expect(u.push(QUIET)).toBeNull();
    expect(u.active).toBe(false);
  });
  test("speech ends on the pause after it, not during it", () => {
    const u = collector();
    for (let i = 0; i < 20; i++) u.push(LOUD);
    expect(u.active).toBe(true);
    // 200 ms of pause is 10 frames of 20 ms; the ninth must not end the turn
    for (let i = 0; i < 9; i++) expect(u.push(QUIET)).toBeNull();
    const said = u.push(QUIET);
    expect(said).not.toBeNull();
    expect(u.active).toBe(false);
  });
  test("the pause resets when Chris starts again, so a comma does not end the turn", () => {
    const u = collector();
    for (let i = 0; i < 20; i++) u.push(LOUD);
    for (let i = 0; i < 5; i++) u.push(QUIET);
    u.push(LOUD);
    for (let i = 0; i < 9; i++) expect(u.push(QUIET)).toBeNull();
    expect(u.push(QUIET)).not.toBeNull();
  });
  test("the audio before the decision is kept, so the first word survives", () => {
    const u = collector();
    for (let i = 0; i < 5; i++) u.push(QUIET);
    for (let i = 0; i < 20; i++) u.push(LOUD);
    let said: Utterance | null = null;
    for (let i = 0; i < 10 && !said; i++) said = u.push(QUIET);
    // the frames it took to decide speech had started are in there, not thrown away
    expect(said).not.toBeNull();
    expect((said as Utterance).samples.length).toBeGreaterThan(20 * LOUD.length);
  });
  test("road noise opens a recording and does not stop the bridge (11.3)", () => {
    const u = collector();
    for (let i = 0; i < 40; i++) u.push(NOISE);
    expect(u.active).toBe(true);
    expect(u.bargingIn).toBe(false);
  });
  test("speech held long enough is a barge-in", () => {
    const u = collector();
    // 200 ms of barge-in is 10 frames of 20 ms; the ninth must not be enough
    for (let i = 0; i < 9; i++) u.push(LOUD);
    expect(u.bargingIn).toBe(false);
    u.push(LOUD);
    expect(u.bargingIn).toBe(true);
  });
  test("a dip between syllables does not reset the count", () => {
    const u = collector();
    // 100 ms of speech, a 60 ms gap, 100 ms more: one phrase, not two attempts
    for (let i = 0; i < 5; i++) u.push(LOUD);
    for (let i = 0; i < 3; i++) u.push(QUIET);
    expect(u.bargingIn).toBe(false);
    for (let i = 0; i < 5; i++) u.push(LOUD);
    expect(u.bargingIn).toBe(true);
  });
  test("a real pause does reset it, so two short noises are not one barge-in", () => {
    const u = collector();
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 5; j++) u.push(LOUD);
      for (let j = 0; j < 6; j++) u.push(QUIET);
    }
    expect(u.bargingIn).toBe(false);
  });
  test("the barge-in clears with the utterance it belonged to", () => {
    const u = collector();
    for (let i = 0; i < 20; i++) u.push(LOUD);
    expect(u.bargingIn).toBe(true);
    for (let i = 0; i < 10; i++) u.push(QUIET);
    expect(u.bargingIn).toBe(false);
  });
  test("an utterance says what it was, which is what a fragmented session needs", () => {
    const u = collector();
    for (let i = 0; i < 10; i++) u.push(QUIET);   // 200 ms of room
    for (let i = 0; i < 25; i++) u.push(LOUD);    // 500 ms of speech
    let said: Utterance | null = null;
    for (let i = 0; i < 12 && !said; i++) said = u.push(QUIET);
    expect(said).not.toBeNull();
    const heard = said as Utterance;
    expect(heard.endedBy).toBe("pause");
    // the speech, plus the pause that ended it
    expect(heard.ms).toBeGreaterThan(600);
    expect(heard.speechMs).toBeGreaterThan(400);
    expect(heard.speechMs).toBeLessThan(heard.ms);
    expect(heard.peak).toBeGreaterThan(0.1);
    expect(heard.gapMs).toBeGreaterThan(100);
  });

  test("what is held when the stream ends is still an utterance", () => {
    const u = collector();
    for (let i = 0; i < 20; i++) u.push(LOUD);
    expect(u.flush()?.endedBy).toBe("flush");
    expect(u.flush()).toBeNull();
  });
});

describe("too quiet to have been a person", () => {
  const heard = (peak: number) => ({ samples: new Int16Array(0), ms: 2_100, speechMs: 400, peak, gapMs: 1_500, endedBy: "pause" as const, falseEnds: 0 });
  test("the levels measured on 14 September fall either side of the default", () => {
    // "Thank you." came out of this one, and Chris never said it
    expect(tooQuiet(heard(0.12), 0.15)).toBe(true);
    // and these are what he actually sounded like
    for (const peak of [0.43, 0.46, 0.48, 0.50, 0.52, 0.55]) {
      expect(tooQuiet(heard(peak), 0.15)).toBe(false);
    }
  });
  test("the threshold is a setting, not a verdict", () => {
    expect(tooQuiet(heard(0.30), 0.5)).toBe(true);
    expect(tooQuiet(heard(0.30), 0.1)).toBe(false);
  });
});
