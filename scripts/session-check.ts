#!/usr/bin/env bun
/**
 * A drive you can repeat, and a score you can compare (spec 18).
 *
 * The numbers that decide the remaining settings need a person talking into a
 * phone, and "it felt better than last time" cannot settle anything. This
 * prints a card to read and then scores what the bridge recorded against it,
 * so two builds differ by figures rather than by memory.
 *
 *   bun scripts/session-check.ts card     what to say, in order
 *   bun scripts/session-check.ts score    how it went
 *
 * Read the card with the bridge connected, then score it whenever you like:
 * the record is on disk, and a restart no longer takes the drive with it.
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

function report(): void {
  // the last session that heard anything, which is the drive. The empty
  // session a restart leaves behind is not one.
  const drive = readDrive(config.recordPath);
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
if (what === "card") card();
else if (what === "score") report();
else { console.error("usage: bun scripts/session-check.ts <card|score>"); process.exit(2); }
