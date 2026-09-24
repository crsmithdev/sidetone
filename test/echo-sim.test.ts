import { describe, expect, test } from "bun:test";
import { Utterances, type Utterance } from "../src/audio.ts";
import { likeness, verdict } from "../src/echo.ts";
import { cancelled, echo, frames, hear, mix, peakLevel, quiet, voice } from "./echo-path.ts";
import { bridge, RATE, TEST_CONFIG } from "./harness.ts";

/**
 * The echo without the car (18.10, 18.13). On 23 September the microphone
 * brought a whole passage back, and three guards stood between that and a
 * fault: the phone's canceller, which failed; the barge-in gate, which never
 * fired; and the echo drop, which caught it. The two that live here are fed
 * the bridge's own voice, delayed and made quieter, through `Ear.frame`, while
 * the mouth holds the reply as what it has just said.
 */

/** The turn a client asks for is nobody's promise here, so the test waits for it. */
async function until(done: () => boolean, ms = 2_000): Promise<void> {
  const stop = Date.now() + ms;
  while (!done() && Date.now() < stop) await Bun.sleep(2);
}

/** 18.13 the passage the echo check says, and what the car brought back, word for word from the record. */
const PASSAGE = [
  "This is the echo check, and nobody needs to answer it.",
  "The bridge is talking to itself to find out whether the phone can hear it.",
  "If the microphone brings these words back, the echo canceller is not holding.",
  "A pass means the room stayed quiet while every one of these sentences played.",
];
const BACK = "This is the echo chat and nobody needs to answer it. The bridge is talking to itself to "
  + "find out whether the phone can hear it. If the microphone brings these words back, the echo "
  + "counselor is not holding. The pass leaves the room stay quiet while every one of these "
  + "sentences played.";

/**
 * The car of 23 September, as the record has it: one utterance of 14.9 s,
 * 7.9 s of it above the speech level, peak 0.543, and no barge-in for 100 s
 * either side. The record keeps the sums, not the shape. The shape here is
 * the one that makes those sums under the explanation in the to-do: the
 * canceller let the onset of each sentence through and held the rest down,
 * so the gate saw bursts shorter than `bargeInMs` with dips longer than
 * `bargeInGapMs` between them.
 */
const CAR = { peak: 0.543, leakMs: 300, residual: 0.08, delayMs: 120 };

/** The passage as the car's microphone heard it. */
function carEcho(samples: Int16Array): Int16Array {
  return cancelled(echo(samples, { delayMs: CAR.delayMs, gain: CAR.peak / peakLevel(samples) }), { leakMs: CAR.leakMs, residual: CAR.residual });
}

/** The voice says the sentences into the room, and the test knows what the engine will write for what comes back. */
async function spoke(sentences: readonly string[], back: string) {
  const r = bridge();
  r.stt.transcribe = async () => back;
  for (const sentence of sentences) r.mouth.say(sentence);
  await until(() => r.said.length === sentences.length);
  return r;
}

const kinds = (r: ReturnType<typeof bridge>) => r.measures.recent().map((event) => event.kind);
const asked = (r: ReturnType<typeof bridge>) => r.agent.calls.filter((call) => call.startsWith("ask"));

describe("the echo path", () => {
  test("the voice has the shape of speech: a peak a person has, and a length the words take", () => {
    const one = voice(PASSAGE[0]!);
    // Chris's peaks in the record run 0.4 to 0.55; a sentence of fifteen syllables takes three to four seconds to read
    expect(peakLevel(one)).toBeGreaterThan(0.45);
    expect(peakLevel(one)).toBeLessThan(0.55);
    expect(one.length / RATE).toBeGreaterThan(2.5);
    expect(one.length / RATE).toBeLessThan(4.5);
  });

  test("an echo is later and quieter, and a room adds a second copy", () => {
    const one = voice(PASSAGE[0]!);
    const back = echo(one, { delayMs: 100, gain: 0.5 });
    expect(back.length).toBe(one.length + RATE / 10);
    expect(peakLevel(back.subarray(0, RATE / 10))).toBe(0);
    expect(peakLevel(back)).toBeCloseTo(peakLevel(one) / 2, 2);
    const room = echo(one, { delayMs: 100, gain: 0.5, room: { delayMs: 300, gain: 0.25 } });
    expect(room.length).toBe(one.length + (RATE * 3) / 10);
    // the room is the direct copy and the wall's copy, sample for sample
    const wall = echo(one, { delayMs: 300, gain: 0.25 });
    expect(Array.from(room)).toEqual(Array.from(wall, (sample, i) => sample + (back[i] ?? 0)));
  });

  test("the canceller lets the onset of a sentence through and holds the rest down", () => {
    const one = voice(PASSAGE[0]!);
    const held = cancelled(one, { leakMs: 300, residual: 0.1 });
    const onset = (RATE * 3) / 10;
    expect(peakLevel(held.subarray(0, onset))).toBe(peakLevel(one.subarray(0, onset)));
    expect(peakLevel(held.subarray(onset))).toBeLessThanOrEqual(peakLevel(one.subarray(onset)) * 0.1 + 0.001);
    expect(peakLevel(held.subarray(onset))).toBeGreaterThan(0);
  });
});

describe("the bridge hears its own voice back (18.10.1)", () => {
  const sentence = "The service restarted about nine minutes ago.";

  test("a clean echo of the sentence barges in, is known for the bridge's own, and is dropped, so the held answer resumes", async () => {
    // the volume slider of 21 September: the speaker reached the microphone with nothing between them
    const r = await spoke([sentence], "the service restarted about nine minutes ago");
    r.mouth.say("the rest.");
    hear(r.ear, echo(voice(sentence), { delayMs: 60, gain: 0.8 }));
    // the echo is loud and unbroken, so the gate takes it for Chris and holds the rest
    expect(kinds(r)).toContain("barged");
    await until(() => r.said.includes("the rest."));
    expect(r.said).toEqual([sentence, "the rest."]);
    expect(kinds(r)).toContain("echo");
    expect(r.journal.some((line) => line.includes(`dropped "the service restarted about nine minutes ago" as its own echo of "${sentence}"`))).toBe(true);
    // it took the path of an utterance with no words: nobody was told, nobody was asked
    expect(r.told.some((message) => message.kind === "heard")).toBe(false);
    expect(asked(r)).toEqual([]);
  });

  test("the whole passage comes back as one utterance, as in the car, and it is an echo in the verdict too (18.10.3, 18.13)", async () => {
    const r = await spoke(PASSAGE, BACK);
    hear(r.ear, carEcho(voice(PASSAGE.join(" "))));
    await until(() => r.journal.some((line) => line.includes("dropped")));
    const heard = r.measures.recent().filter((event) => event.kind === "heard");
    // one utterance for four sentences, as long as the car's 14.9 s, and no gate fired on it
    expect(heard).toHaveLength(1);
    expect(heard[0]!.ms).toBeGreaterThan(15_000);
    expect(heard[0]!.peak).toBeCloseTo(CAR.peak, 1);
    expect(kinds(r)).not.toContain("barged");
    // the run of sentences is what it echoes, not any one of them
    const echoes = r.measures.recent().flatMap((event) => (event.kind === "echo" ? [event] : []));
    expect(echoes).toHaveLength(1);
    expect(echoes[0]!.spoke).toBe(PASSAGE.join(" "));
    expect(asked(r)).toEqual([]);
    // and the check, read from the same record, says the microphone brought the passage back
    const result = verdict(r.measures.recent(), PASSAGE, Date.now() + 1);
    expect(result.code).toBe(1);
    expect(result.word).toContain("brought the passage back");
    expect(result.lines.some((line) => line.endsWith(", an echo"))).toBe(true);
  });

  test("what Chris says over the voice is heard, not dropped", async () => {
    // the two real lines of 23 September, and how close their letters came to what the voice was saying
    const lines: Array<[said: string, voice: string, close: number]> = [
      ["Agree with the recommendation.", "I found how the bubble is built, and I have a recommendation.", 0.65],
      ["That's an argument level factor.", "I'll check the barge-in level for that turn.", 0.54],
    ];
    for (const [line, said, close] of lines) {
      expect(likeness(line, said)).toBeCloseTo(close, 2);
      const r = await spoke([said], line);
      // the canceller holds, so what the microphone carries is Chris, with a trace of the speaker under him
      hear(r.ear, mix(voice(line), echo(voice(said), { delayMs: 120, gain: 0.02 })));
      await until(() => asked(r).length > 0);
      expect(kinds(r)).toContain("barged");
      expect(kinds(r)).not.toContain("echo");
      expect(r.told).toContainEqual({ kind: "heard", text: line });
      expect(asked(r)[0]).toEndWith(`\n\n${line}`);
    }
  });
});

describe("the barge-in gate and the car of 23 September (11.3)", () => {
  test("an echo the canceller lets through in 300 ms bursts, with dips of 200 ms and more, never barges in", () => {
    // the settings the car ran that day, from the record's session line
    expect(TEST_CONFIG).toMatchObject({ bargeInLevel: 0.05, bargeInMs: 400, bargeInGapMs: 200, speechLevel: 0.02 });
    const passage = voice(PASSAGE.join(" "));
    const car = carEcho(passage);
    expect(peakLevel(car)).toBeCloseTo(CAR.peak, 1);

    const gate = new Utterances({ ...TEST_CONFIG, sampleRate: RATE });
    let barged = false;
    const done: Utterance[] = [];
    for (const frame of [...frames(car), ...quiet(1_600)]) {
      const finished = gate.push(frame);
      if (finished) done.push(finished);
      barged ||= gate.bargingIn;
    }
    // Peak 0.54 is ten times bargeInLevel, and the gate never fired: each
    // burst held 300 ms of the 400 it needs, and the dip after it ran past
    // 200 ms, which puts the count back to nothing. The whole passage was
    // still one utterance, so the words were the only guard left.
    expect(barged).toBe(false);
    expect(done).toHaveLength(1);
    expect(done[0]!.ms).toBeGreaterThan(15_000);

    // the same passage with no canceller at all, which is 21 September, fires it at once
    const bare = new Utterances({ ...TEST_CONFIG, sampleRate: RATE });
    let fired = false;
    for (const frame of frames(echo(passage, { delayMs: CAR.delayMs, gain: 1 }))) { bare.push(frame); fired ||= bare.bargingIn; }
    expect(fired).toBe(true);
  });
});
