/**
 * Audible state (spec section 15). Silence is ambiguous: when the bridge
 * cannot answer yet, it says so with a sound rather than with nothing (15.1).
 *
 * A cue only starts after a delay, so an ordinary wait stays quiet (15.5).
 * Each state has its own figure, so Chris can tell them apart without words
 * (15.4). The three mean exactly one thing each, and nothing else:
 *
 * | cue | when | figure |
 * |---|---|---|
 * | `heard` | your turn ended and the bridge took the recording | one note |
 * | `thinking` | the turn is running and has said nothing yet | a falling fourth |
 * | `starting` | the Claude Code process is coming back up | a rising third |
 *
 * The design is "warm-low-short", chosen by ear from twenty-six candidates
 * on 13 September 2026. Three things about it are not taste:
 *
 * - **The register.** In-vehicle auditory signals want components between 500
 *   and 1500 Hz. The cue this replaced sat at 196 to 330, in with the engine,
 *   and measured below the road noise rather than above it. C5 is the bottom
 *   of the useful band and this sits on it.
 * - **The detuning.** Two sines six cents apart beat gently against each
 *   other. That is the whole difference between a note and a test signal.
 * - **The length.** A routine cue wants to be under about 300 ms. These run
 *   160 to 300.
 *
 * Measured against a road-noise bed, filtered to the band that decides
 * audibility, this stands about 12 dB above it. The reading asks for 15, and
 * the shortfall is the price of being low and short, which is what Chris
 * wanted. `cueVolume` is the setting that closes the gap.
 */
import { join } from "node:path";

export type CueName = "heard" | "thinking" | "starting";

/** Six cents. The ratio is 2^(6/1200). */
const DETUNE = 1.00347;

/** A note is a detuned pair with a little octave for body: ratio, then gain. */
const PARTIALS: Array<[number, number]> = [[1, 0.46], [DETUNE, 0.46], [2, 0.08]];

/** Half-sine fades at both ends, scaled short with the notes. */
const FADE_IN = 0.02;
const FADE_OUT = 0.13;

/** How much room the reverb is in: 0 to 100. */
const REVERB = 18;

/** Each cue is a run of notes: hertz, then seconds. C5, G4 and E5. */
const CUES: Record<CueName, Array<[number, number]>> = {
  heard: [[523, 0.16]],
  thinking: [[523, 0.12], [392, 0.18]],
  starting: [[523, 0.12], [659, 0.18]],
};

export class Cues {
  private files = new Map<CueName, string>();

  constructor(private readonly dir: string, private readonly volume = 0.12) {}

  /** 15.6 pleasant and calm: quiet, short, and faded at both ends so it never clicks. */
  async build(): Promise<void> {
    for (const [name, notes] of Object.entries(CUES) as Array<[CueName, Array<[number, number]>]>) {
      const parts: string[] = [];
      for (const [index, [hertz, seconds]] of notes.entries()) {
        const note = join(this.dir, `cue-${name}-${index}.wav`);
        if (!await this.note(note, hertz, seconds)) return;
        parts.push(note);
      }
      const wav = join(this.dir, `cue-${name}.wav`);
      // The reverb runs before the level is set, and the level is set by
      // normalising the peak rather than by scaling each note. Scaling each
      // note is how the old cue ended up with one note six times louder than
      // the other: an effect in sox belongs to the chain it is written in.
      const done = await this.sox([...parts, wav,
        "reverb", String(REVERB), "50", "40", "100", "0", "0",
        "gain", "-n", (20 * Math.log10(this.volume)).toFixed(2),
      ]);
      if (done) this.files.set(name, wav);
    }
  }

  /** One note: a detuned pair mixed together, then shaped. */
  private async note(path: string, hertz: number, seconds: number): Promise<boolean> {
    const partials: string[] = [];
    for (const [index, [ratio, gain]] of PARTIALS.entries()) {
      const partial = join(this.dir, `partial-${index}.wav`);
      if (!await this.sox(["-n", ...FORMAT, partial,
        "synth", seconds.toFixed(3), "sine", (hertz * ratio).toFixed(2), "vol", gain.toFixed(3),
      ])) return false;
      partials.push(partial);
    }
    const mixed = join(this.dir, "mixed.wav");
    if (!await this.sox(["-m", ...partials, mixed])) return false;
    return this.sox([mixed, path, "fade", "h", FADE_IN.toFixed(3), "0", FADE_OUT.toFixed(3)]);
  }

  private async sox(args: string[]): Promise<boolean> {
    return await Bun.spawn(["sox", ...args], { stdout: "ignore", stderr: "ignore" }).exited === 0;
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
