/**
 * Audible state (spec section 15). Silence is ambiguous: when the bridge
 * cannot answer yet, it says so with a sound rather than with nothing (15.1).
 *
 * A cue only starts after a delay, so an ordinary wait stays quiet (15.5).
 * Each state has its own figure, so Chris can tell them apart without words
 * (15.4). The five mean exactly one thing each, and nothing else:
 *
 * | cue | when | figure |
 * |---|---|---|
 * | `heard` | your turn ended and the bridge took the recording | one click |
 * | `thinking` | the turn is running and has said nothing yet | two clicks, bright then dark |
 * | `starting` | the Claude Code process is coming back up | three clicks, dark to bright |
 * | `hold` | Chris pressed hold to talk (15.14) | one short bright click |
 * | `release` | Chris let go of hold to talk (15.14) | one short dark click |
 *
 * A click is a burst of noise cut to a band, not a note. Chris asked on 22
 * September 2026 for cues closer to a click than a tone, more atonal and
 * quieter than the detuned-sine notes of 13 September. Four things about the
 * design are not taste:
 *
 * - **The noise.** Noise has no pitch, so a click cannot sound like a musical
 *   note. The band gives each click a brightness in place of a pitch. The
 *   figures differ by the count first and the brightness second, because a
 *   count survives road noise better than a small change in colour.
 * - **The register.** In-vehicle auditory signals want components between 500
 *   and 1500 Hz. The bands sit in 500 to 2000, the band that decides
 *   audibility against the road, and nothing is below 500, in with the engine.
 * - **The shape.** A 40 ms click with a half-sine fall keeps about 7 dB more
 *   energy in that band than an exponential fall of the same length. The
 *   2 ms rise keeps the onset sharp but stops a digital pop.
 * - **The length.** A routine cue wants to be under about 300 ms. These run
 *   90 to 270, with the reverb tail. The two hold to talk cues are shorter
 *   again (15.14), because they play on every hold.
 *
 * Measured as the loudest 100 ms, filtered to 500-2000 Hz, the clicks stand
 * 4 to 6 dB below the notes they replace at the new default level. The notes
 * stood about 12 dB above a road-noise bed filtered the same way, so the
 * clicks stand about 6 to 8 above it. That is what quieter costs, and a
 * short sound is also heard as quieter than a long one at the same peak.
 * `cueVolume` is the setting that buys the margin back. The reading was
 * done on a bench; a human ear in the car has not confirmed it yet.
 */
import { join } from "node:path";

export type CueName = "heard" | "thinking" | "starting" | "hold" | "release";

/** A click is 40 ms of noise: long enough to carry, short enough to stay a click. */
const CLICK = 0.04;

/** A 2 ms rise: sharp enough for a click, soft enough to stop a digital pop. */
const ATTACK = 0.002;

/** From the start of one click to the start of the next, so each stays separate. */
const STEP = 0.09;

/** Room for the reverb to ring out after the last click. */
const TAIL = 0.05;

/** 15.14 the two cues that play on every hold are half as long as the others. */
const HOLD_CLICK = 0.02;
const HOLD_TAIL = 0.02;

/** How much room the reverb is in: 0 to 100. */
const REVERB = 18;

/** Each cue is a run of clicks, each a band of noise: low hertz, then high. */
const CUES: Record<CueName, Array<[number, number]>> = {
  heard: [[700, 1500]],
  thinking: [[1100, 2000], [500, 900]],
  starting: [[500, 900], [700, 1500], [1100, 2000]],
  // 15.14 brighter and darker than `heard`, so a release and the `heard`
  // behind it do not blur into one sound.
  hold: [[1100, 2000]],
  release: [[500, 900]],
};

/**
 * 15.14 a cue that plays on every hold is half as loud as the others. The
 * level is a fraction of `cueVolume`, so the setting still moves all five.
 */
const LEVEL: Partial<Record<CueName, number>> = { hold: 0.5, release: 0.5 };

export class Cues {
  private files = new Map<CueName, string>();

  constructor(private readonly dir: string, private readonly volume = 0.1) {}

  /** 15.6 calm: quiet and short, with a soft rise so the onset does not pop. */
  async build(): Promise<void> {
    for (const [name, clicks] of Object.entries(CUES) as Array<[CueName, Array<[number, number]>]>) {
      const parts: string[] = [];
      const short = name === "hold" || name === "release";
      const length = short ? HOLD_CLICK : CLICK;
      for (const [index, band] of clicks.entries()) {
        const click = join(this.dir, `cue-${name}-${index}.wav`);
        const last = index === clicks.length - 1;
        const after = last ? (short ? HOLD_TAIL : TAIL) : STEP - CLICK;
        if (!await this.click(click, band, length, after)) return;
        parts.push(click);
      }
      const wav = join(this.dir, `cue-${name}.wav`);
      // The reverb runs before the level is set, and the level is set by
      // normalising the peak rather than by scaling each click. Scaling each
      // note is how the old cue ended up with one note six times louder than
      // the other: an effect in sox belongs to the chain it is written in.
      const done = await this.sox([...parts, wav,
        "reverb", String(REVERB), "50", "40", "100", "0", "0",
        "gain", "-n", (20 * Math.log10(this.volume * (LEVEL[name] ?? 1))).toFixed(2),
      ]);
      if (done) this.files.set(name, wav);
    }
  }

  /** One click: white noise cut to a band, with a half-sine fall, then silence. */
  private async click(path: string, [low, high]: [number, number], length: number, after: number): Promise<boolean> {
    return this.sox(["-n", ...FORMAT, path,
      "synth", length.toFixed(3), "whitenoise",
      "sinc", `${low}-${high}`,
      "fade", "h", ATTACK.toFixed(3), "0", (length - ATTACK).toFixed(3),
      "pad", "0", after.toFixed(3),
    ]);
  }

  /** -R seeds the noise and the dither the same way each time, so a cue is the same on each start. */
  private async sox(args: string[]): Promise<boolean> {
    return await Bun.spawn(["sox", "-R", ...args], { stdout: "ignore", stderr: "ignore" }).exited === 0;
  }

  /** The file. The speaker plays it, or sends its bytes. */
  file(name: CueName): string | undefined {
    return this.files.get(name);
  }
}

/**
 * -b 16 -e signed-integer is not optional: sox writes 32-bit float by default,
 * which plays locally and is refused by the wav reader that feeds the transport.
 */
const FORMAT = ["-r", "22050", "-c", "1", "-b", "16", "-e", "signed-integer"];
