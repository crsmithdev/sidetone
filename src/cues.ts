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
 * | `heard` | your turn ended and the bridge took the recording | one short high note |
 * | `thinking` | the turn is running and has said nothing yet | a falling pair |
 * | `starting` | the Claude Code process is coming back up | a rising pair |
 */
import { join } from "node:path";

export type CueName = "heard" | "thinking" | "starting";

/** Each cue is a run of notes: hertz, then seconds. */
const CUES: Record<CueName, Array<[number, number]>> = {
  heard: [[523, 0.09]],
  thinking: [[392, 0.16], [330, 0.2]],
  starting: [[330, 0.16], [494, 0.2]],
};

export class Cues {
  private files = new Map<CueName, string>();

  constructor(private readonly dir: string, private readonly volume = 0.12) {}

  /** 15.6 pleasant and calm: quiet, short, and faded at both ends so it never clicks. */
  async build(): Promise<void> {
    for (const [name, notes] of Object.entries(CUES) as Array<[CueName, Array<[number, number]>]>) {
      const wav = join(this.dir, `cue-${name}.wav`);
      const chains: string[] = [];
      for (const [hertz, seconds] of notes) {
        // Every note carries its own fade and its own vol. Sox starts a new
        // effect chain at ":", and an effect only applies to the chain it is
        // in, so a single trailing "vol" leaves every note before it at full
        // scale — which is the cue that came out unusually loud in the car.
        if (chains.length > 0) chains.push(":");
        chains.push(
          "synth", seconds.toFixed(2), "sine", String(hertz),
          "fade", "q", Math.min(0.03, seconds / 4).toFixed(3), "0", Math.min(0.08, seconds / 3).toFixed(3),
          "vol", this.volume.toFixed(3),
        );
      }
      const done = await Bun.spawn([
        // -b 16 -e signed-integer is not optional: sox writes 32-bit float by
        // default, which plays locally and is refused by the wav reader that
        // feeds the transport.
        "sox", "-n", "-r", "22050", "-c", "1", "-b", "16", "-e", "signed-integer", wav, ...chains,
      ], { stdout: "ignore", stderr: "ignore" }).exited;
      if (done === 0) this.files.set(name, wav);
    }
  }

  /** The file, for a transport that sends bytes rather than plays them. */
  file(name: CueName): string | undefined {
    return this.files.get(name);
  }

  async play(name: CueName): Promise<void> {
    const wav = this.files.get(name);
    if (!wav) return;
    await Bun.spawn(["paplay", wav], { stdout: "ignore", stderr: "ignore" }).exited;
  }
}
