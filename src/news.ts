/**
 * Item 76 the level of the notifications, applied to aleph's job news
 * (14.10.6), apart from the verbosity of answers (9.4.10).
 *
 * A line of job news is `<repo>/<name> <state>` and sometimes more after it,
 * or `<name> finished|failed` for a plain command. Full passes each line as
 * aleph sent it. Brief passes only a start, an end or a failure, as the name
 * and one of those three words, and a line to the agent that says to say only
 * that. Off passes nothing.
 */
import type { NotificationLevel } from "./config.ts";

/** Item 76 the one line at the head of a brief news turn; the agent reads it, as it reads the verbosity line. */
export const BRIEF_NEWS_LINE = "[From the bridge, not from Chris: notifications are brief. For each job, say only its name and that it started, finished or failed. Run nothing.]";

/** The states of aleph's runs, and plain commands' two words, as brief says them. */
const BRIEF_WORDS: Record<string, string> = {
  running: "started",
  passed: "finished",
  done: "finished",
  landed: "finished",
  finished: "finished",
  failed: "failed",
};

/** A line of news cut to its name and its brief word; null when brief says nothing of it. */
export function briefLine(line: string): string | null {
  const [name, state] = line.split(/[ ;]/);
  const word = state === undefined ? undefined : BRIEF_WORDS[state];
  return name && word ? `${name} ${word}` : null;
}

/**
 * The turn that goes to the agent for the queued lines, at the level in
 * force; null when the level leaves nothing to say.
 */
export function newsTurn(lines: string[], level: NotificationLevel): string | null {
  if (level === "off") return null;
  const kept = level === "brief" ? lines.map(briefLine).filter((line) => line !== null) : lines;
  if (kept.length === 0) return null;
  const marked = kept.map((line) => `[job news] ${line}`).join("\n");
  return level === "brief" ? `${BRIEF_NEWS_LINE}\n\n${marked}` : marked;
}
