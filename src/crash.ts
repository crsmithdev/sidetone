/**
 * The crash report, on disk (spec 14.14).
 *
 * The app writes a report when it crashes, and sends it here when it next joins
 * the room. The agent cannot see a phone, so this writes the report to a file
 * the agent reads. One report is one message: the app cuts it to fit.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CRASH_DIR = join(homedir(), ".sidetone", "crashes");

/** The id becomes a file name, so it is one plain word. */
const ID = /^[A-Za-z0-9-]{1,64}$/;

/** One crash report from the phone. It returns the line for the journal: where the report goes, or what went wrong. */
export function receiveCrash(value: Record<string, unknown>, dir = CRASH_DIR): string {
  const { id, text } = value;
  if (typeof id !== "string" || !ID.test(id) || typeof text !== "string") return "a crash report from the phone was not readable";
  const file = join(dir, `${id}.txt`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, text);
  } catch (error) {
    return `the crash report was not written: ${(error as Error).message}`;
  }
  return `crash report at ${file}`;
}
