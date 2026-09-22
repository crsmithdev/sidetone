/**
 * The screen log, on disk (spec 14.11).
 *
 * The app keeps a log of what it showed: for each change, the time, the kind
 * of message, the bubble and the text on the screen. The agent cannot see a
 * phone, so the app sends each entry here as it happens, and this appends it
 * to a file the agent reads. The bridge does not read the entries.
 *
 * One file holds one log of the app, which the `id` names, so a reconnect
 * carries on the same file. `latest.jsonl` points at the file written last.
 */
import { appendFileSync, mkdirSync, rmSync, symlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const SCREEN_DIR = join(homedir(), ".sidetone", "screen");

/** The id becomes a file name, so it is one plain word. */
const ID = /^[A-Za-z0-9-]{1,64}$/;

type Entry = Record<string, unknown>;

export class Screens {
  private current: string | null = null;

  constructor(private readonly dir = SCREEN_DIR) {}

  /** Entries of one log. It returns the lines for the journal: where a new log goes, or what went wrong. */
  receive(value: Record<string, unknown>): string[] {
    const { id, entries } = value;
    if (typeof id !== "string" || !ID.test(id) || !Array.isArray(entries)) {
      return ["a part of the screen log from the phone was not readable"];
    }
    const lines = entries.filter((entry): entry is Entry => typeof entry === "object" && entry !== null);
    const file = join(this.dir, `${id}.jsonl`);
    const said: string[] = [];
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(file, lines.map((entry) => `${JSON.stringify(entry)}\n`).join(""));
      if (this.current !== id) {
        this.current = id;
        const latest = join(this.dir, "latest.jsonl");
        rmSync(latest, { force: true });
        symlinkSync(`${id}.jsonl`, latest);
        said.push(`screen log at ${file}`);
      }
    } catch (error) {
      return [`the screen log was not written: ${(error as Error).message}`];
    }
    return said;
  }
}
