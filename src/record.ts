/**
 * The drive record, on disk (spec 18).
 *
 * The scorecard reads what the process remembers. On 14 September the service
 * restarted twenty seconds after a drive ended and `score` printed zeros for a
 * session that had just happened. The journal still held the lines, but the
 * journal has no word accuracy in it and nobody works out a median by eye.
 *
 * One line of JSON for each event, appended as it happens. A header line opens
 * each session and carries the settings in force, so a card read a week ago can
 * still be compared with one read today. It writes; it decides nothing.
 */
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Event } from "./diagnostics.ts";

/** The line that opens a session, and the settings that produced everything after it. */
export interface Header {
  kind: "session";
  at: number;
  settings: Record<string, unknown>;
}

export type Line = Header | Event;

/** A session read back: its settings, and everything it heard. */
export interface Drive {
  at: number;
  settings: Record<string, unknown>;
  events: Event[];
}

export class Recorder {
  private failed = false;

  constructor(private readonly path: string) {}

  /** Open a session. Everything appended after this belongs to it. */
  session(settings: Record<string, unknown>, at = Date.now()): void {
    try { mkdirSync(dirname(this.path), { recursive: true }); } catch { /* the append will say so */ }
    this.write({ kind: "session", at, settings });
  }

  /**
   * A record that cannot be written must not stop the bridge talking, so a
   * failure is said once and then swallowed. The measurement is worth less
   * than the conversation it measures.
   */
  write(line: Line): void {
    if (this.failed) return;
    try {
      appendFileSync(this.path, `${JSON.stringify(line)}\n`);
    } catch (error) {
      this.failed = true;
      console.log(`[the drive record is not being written: ${(error as Error).message}]`);
    }
  }
}

/**
 * The last session that heard anything.
 *
 * Not simply the last session: the restart this file exists for leaves an empty
 * one at the end of the file, and reading that back is the same zeros in a
 * different place.
 */
export function readDrive(path: string): Drive | null {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return null; }
  const lines: Line[] = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    // a hard kill truncates the last line; the rest of the file is still good
    try { lines.push(JSON.parse(raw) as Line); } catch { continue; }
  }
  let drive: Drive | null = null;
  let open: Drive | null = null;
  for (const line of lines) {
    if (line.kind === "session") {
      open = { at: line.at, settings: line.settings, events: [] };
      continue;
    }
    // a file written by an older build may have no header at all
    if (!open) open = { at: line.at, settings: {}, events: [] };
    open.events.push(line);
    if (line.kind === "heard") drive = open;
  }
  return drive;
}
