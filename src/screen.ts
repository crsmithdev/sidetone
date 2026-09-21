/**
 * The screen log, on disk (spec 14.11).
 *
 * The app keeps a log of what it showed: for each change, the time, the kind
 * of message, the bubble and the text on the screen. The agent cannot see a
 * phone, so a button in the app sends the log here and this writes it to a
 * file the agent reads. The bridge does not read the entries. It writes them.
 *
 * The log is larger than one data message can carry, so the app sends it in
 * parts. A part names the log it belongs to (`id`), its place (`part`) and how
 * many there are (`of`). Only one log is put together at a time: the channel is
 * reliable and in order, so a part of a new log means the old one is not coming.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SCREEN_DIR = join(homedir(), ".sidetone", "screen");

/** The most parts one log may have. The app sends at most about twenty. */
const MAX_PARTS = 200;

type Entry = Record<string, unknown>;

export class Screens {
  private pending: { id: string; of: number; parts: Map<number, Entry[]> } | null = null;

  constructor(
    private readonly dir = SCREEN_DIR,
    private readonly now = () => new Date(),
  ) {}

  /** One part of a log. It returns the lines to say: none until the log is whole, then where it was written. */
  receive(value: Record<string, unknown>): string[] {
    const { id, part, of, entries } = value;
    if (typeof id !== "string" || typeof part !== "number" || typeof of !== "number" || !Array.isArray(entries)
      || !Number.isInteger(part) || !Number.isInteger(of) || part < 1 || part > of || of > MAX_PARTS) {
      return ["a part of the screen log from the phone was not readable"];
    }
    const said: string[] = [];
    if (this.pending?.id !== id) {
      if (this.pending) said.push("an earlier screen log from the phone did not arrive whole, and was dropped");
      this.pending = { id, of, parts: new Map() };
    }
    this.pending.parts.set(part, entries.filter((entry): entry is Entry => typeof entry === "object" && entry !== null));
    if (this.pending.parts.size < this.pending.of) return said;

    const whole = [...this.pending.parts.entries()].sort((a, b) => a[0] - b[0]).flatMap(([, part]) => part);
    this.pending = null;
    const file = join(this.dir, `${this.now().toISOString().replace(/:/g, "-")}.jsonl`);
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(file, whole.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
    } catch (error) {
      return [...said, `the screen log was not written: ${(error as Error).message}`];
    }
    return [...said, `screen log written to ${file}, ${whole.length} lines`];
  }
}
