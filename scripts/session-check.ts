#!/usr/bin/env bun
/**
 * A drive you can repeat, and a score you can compare (spec 18).
 *
 * The numbers that decide the remaining settings need a person talking into a
 * phone, and "it felt better than last time" cannot settle anything. This
 * prints a card to read and then scores what the bridge recorded against it,
 * so two builds differ by figures rather than by memory.
 *
 *   bun scripts/session-check.ts card        what to say, in order
 *   bun scripts/session-check.ts score       how the last drive went
 *   bun scripts/session-check.ts score 2h    the last two hours, restarts and all
 *   bun scripts/session-check.ts brief 2h    one line of it, for the journal
 *
 * Read the card with the bridge connected, then score it whenever you like:
 * the record is on disk, and a restart no longer takes the drive with it.
 *
 * `brief` is what the timer runs. Every figure here was already being counted
 * and nobody was reading any of them: the coffee shop of 22 September put 70
 * turns nobody asked for through the agent over two hours, and the number that
 * says so was sitting in the record the whole time.
 */
import { loadConfig } from "../src/config.ts";
import { readDrive } from "../src/record.ts";
import { PASSAGE, SCRIPT, score } from "../src/scorecard.ts";

const config = loadConfig();

function card(): void {
  console.log(`
  THE CARD.  Connect the phone first, then read this straight through.
  Leave a clear second between steps. Do not hurry to fix a mistake: a
  misheard line is a measurement.

  1. THE PASSAGE, MUTED. Say "sidetone, mute" first. The passage is not
     a question, and unmuted the agent answers each line as one: three
     confused replies and about thirty cents of allowance. Muted, every
     line is still transcribed and measured and none of it reaches the
     agent.

     Then read these three lines at the pace you would talk to a person.
     One line, one breath.
`);
  for (const line of PASSAGE) console.log(`       "${line}"`);
  console.log(`
     Then say "sidetone, unmute". It should answer "Listening."

  2. THE COMMANDS. Say each one and wait for the answer before the next.
     Two words at most after the wake word: the extra ones are what get
     mangled, and "where are we" or "say that again" only ever worked
     because the matcher forgave the middle of them.
`);
  SCRIPT.forEach((step, i) => console.log(`       ${String(i + 1).padStart(2)}. "${step.say}"`));
  console.log(`
  3. TALKING OVER IT. Ask: "describe what a suspension bridge is in about
     a hundred words". While it is still answering, say "sidetone, stats".
     It should report, then carry on where it stopped.

  4. SILENCE. Say nothing at all for thirty seconds. Nothing should happen:
     any turn taken here is a turn nobody asked for.

  Then:  bun scripts/session-check.ts score
`);
}

/** "2h", "45m", "3d" -- how far back to read. */
function since(text: string | undefined): number | undefined {
  if (!text) return undefined;
  const match = /^(\d+)([mhd])$/.exec(text);
  if (!match) { console.error(`a window looks like 90m, 2h or 3d, not ${text}`); process.exit(2); }
  const [, amount, unit] = match;
  const ms = { m: 60_000, h: 3_600_000, d: 86_400_000 }[unit as "m" | "h" | "d"];
  return Date.now() - Number(amount) * ms;
}

/** One line for the journal: the figures that say a session went wrong. */
function brief(window?: string): void {
  const drive = readDrive(config.recordPath, since(window));
  if (!drive) { console.log(`[card] nothing recorded${window ? ` in the last ${window}` : ""}]`); return; }
  const card = score(drive.events);
  const parts = [
    `heard ${card.heard.total}`,
    `unasked ${card.unasked}`,
    `echoes ${card.echoes}`,
    `invented ${card.invented}`,
    `too quiet ${card.heard.tooQuiet}`,
    `barge-ins ${card.bargeIns}`,
    `answers ${card.roundTrip.rounds}`,
    `round trip ${card.roundTrip.medianMs}ms`,
  ];
  console.log(`[card${window ? ` ${window}` : ""}: ${parts.join(", ")}]`);
  // the two that mean something is wrong rather than merely busy
  if (card.unasked > 0) console.log(`[card: ${card.unasked} utterances the room said, not Chris (18.11)]`);
  if (card.echoes > 0) console.log(`[card: ${card.echoes} times the bridge heard its own voice (18.10)]`);
}

function report(window?: string): void {
  // the last session that heard anything, which is the drive. The empty
  // session a restart leaves behind is not one.
  const drive = readDrive(config.recordPath, since(window));
  if (!drive) {
    console.error(`nothing to score in ${config.recordPath}. Has a drive been recorded since the bridge last started?`);
    process.exit(1);
  }
  const card = score(drive.events);
  const when = new Date(drive.at).toLocaleString();
  const line = (name: string, value: unknown, note = "") => console.log(`  ${name.padEnd(26)} ${String(value).padStart(8)}  ${note}`);

  console.log("\n  COMMANDS");
  line("asked", card.commands.asked);
  line("fired correctly", card.commands.fired, card.commands.fired === card.commands.asked ? "" : "<-- the number to move");
  if (card.commands.missed.length) line("missed", card.commands.missed.join(", "));
  for (const wrong of card.commands.wrong) line("reached the agent", `"${wrong.said}"`, "a command that cost a turn");

  console.log("\n  THE PASSAGE");
  line("lines", card.passage.linesExpected);
  line("utterances heard", card.passage.utterances, card.passage.fragments ? `${card.passage.fragments} more than lines: chopped` : "one per line");
  line("lines read back whole", `${card.passage.whole}/${card.passage.linesExpected}`);
  line("word accuracy", card.passage.accuracy);

  console.log("\n  EVERYTHING HEARD");
  line("utterances", card.heard.total);
  line("empty", card.heard.empty, "noise that correctly cost nothing");
  line("dropped as too quiet", card.heard.tooQuiet);
  line("invented", card.invented, card.invented ? "<-- turns nobody asked for" : "");
  line("what the room said", card.unasked, card.unasked ? "<-- fillers and silence tokens (18.11)" : "");
  line("heard itself", card.echoes, card.echoes ? "<-- the echo canceller is not holding (18.10)" : "");
  line("median length", `${card.heard.medianMs}ms`);
  line("median peak", card.heard.medianPeak, "the level minSpeechPeak is judged against");
  line("barge-ins", card.bargeIns);

  console.log("\n  ROUND TRIP");
  line("answers", card.roundTrip.rounds);
  line("median", `${card.roundTrip.medianMs}ms`);
  line("worst", `${card.roundTrip.worstMs}ms`);

  console.log(`\n  SETTINGS IN FORCE  (the drive of ${when})`);
  for (const [name, value] of Object.entries(drive.settings)) line(name, String(value));
  console.log("");
}

const what = process.argv[2] ?? "card";
const window = process.argv[3];
if (what === "card") card();
else if (what === "score") report(window);
else if (what === "brief") brief(window);
else { console.error("usage: bun scripts/session-check.ts <card|score|brief> [2h]"); process.exit(2); }
