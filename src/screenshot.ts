/**
 * The screenshot, on disk (spec 14.12).
 *
 * Chris takes a screenshot on the phone while the app is on the screen, and
 * the app sends the image here. The agent cannot see a phone, so this writes
 * the image to a file the agent reads. One data message is small, so one image
 * arrives in parts of base64, and this keeps them until it has all of them.
 *
 * One file holds one screenshot, which the `id` names. `latest.jpg` points at
 * the file written last.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SCREENSHOT_DIR = join(homedir(), ".sidetone", "screenshots");

/** The id becomes a file name, so it is one plain word. */
const ID = /^[A-Za-z0-9-]{1,64}$/;

/** 14.12.1 more parts than this is not a screenshot of a phone. */
const MAX_PARTS = 200;

export class Screenshots {
  /** The image that arrives now. A part of a different image drops it. */
  private pending: { id: string; of: number; parts: string[] } | null = null;

  constructor(private readonly dir = SCREENSHOT_DIR) {}

  /** One part of a screenshot. It returns the lines for the journal: where an image goes, or what went wrong. */
  receive(value: Record<string, unknown>): string[] {
    const { id, part, of, data } = value;
    if (
      typeof id !== "string" || !ID.test(id) || typeof data !== "string" ||
      !Number.isInteger(of) || !Number.isInteger(part) ||
      (of as number) < 1 || (of as number) > MAX_PARTS || (part as number) < 1 || (part as number) > (of as number)
    ) {
      return ["a part of a screenshot from the phone was not readable"];
    }
    const said: string[] = [];
    if (this.pending && (this.pending.id !== id || this.pending.of !== of)) {
      said.push(`the screenshot ${this.pending.id} from the phone was not whole, and is dropped`);
      this.pending = null;
    }
    this.pending ??= { id, of: of as number, parts: [] };
    this.pending.parts[(part as number) - 1] = data;
    const { parts } = this.pending;
    if (parts.filter((p) => p !== undefined).length < this.pending.of) return said;
    this.pending = null;
    const file = join(this.dir, `${id}.jpg`);
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(file, Buffer.from(parts.join(""), "base64"));
      const latest = join(this.dir, "latest.jpg");
      rmSync(latest, { force: true });
      symlinkSync(`${id}.jpg`, latest);
    } catch (error) {
      return [...said, `the screenshot was not written: ${(error as Error).message}`];
    }
    return [...said, `screenshot at ${file}`];
  }
}
