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
 * Read the card with the bridge connected, then run score before the next
 * restart: the record it reads is held in memory and goes when the process does.
 */
import { loadConfig } from "../src/config.ts";
import { PASSAGE, SCRIPT, score } from "../src/scorecard.ts";

const config = loadConfig();
/**
 * Over loopback, not the tailnet name. This runs on the machine the bridge is
 * on, and MagicDNS does not resolve here -- the certificate is for a name this
 * host cannot look up. Verification is off for the same reason, and it costs
 * nothing: the request never leaves the machine.
 */
const scheme = config.tlsCert && config.tlsKey ? "https" : "http";
const local = `${scheme}://127.0.0.1:${config.servePort}`;

function card(): void {
  console.log(`
  THE CARD.  Connect the phone first, then read this straight through.
  Leave a clear second between steps. Do not hurry to fix a mistake: a
  misheard line is a measurement.

  1. THE PASSAGE. Read these three lines at the pace you would talk to a
     person. One line, one breath.
`);
  for (const line of PASSAGE) console.log(`       "${line}"`);
  console.log(`
  2. THE COMMANDS. Say each one and wait for the answer before the next.
`);
  SCRIPT.forEach((step, i) => console.log(`       ${String(i + 1).padStart(2)}. "${step.say}"`));
  console.log(`
  3. TALKING OVER IT. Ask: "describe what a suspension bridge is in about
     a hundred words". While it is still answering, say "hey bridge, stats".
     It should report, then carry on where it stopped.

  4. SILENCE. Say nothing at all for thirty seconds. Nothing should happen:
     any turn taken here is a turn nobody asked for.

  Then:  bun scripts/session-check.ts score
`);
}

async function report(): Promise<void> {
  const url = `${local}/diagnostics?n=200`;
  const answer = await fetch(url, { tls: { rejectUnauthorized: false } }).catch(() => null);
  if (!answer?.ok) {
    console.error(`could not read ${url}. Is the bridge running on this machine?`);
    process.exit(1);
  }
  const body = await answer.json() as { recent: Parameters<typeof score>[0]; settings: Record<string, unknown>; latency: Record<string, number> };
  const card = score(body.recent);
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
  line("median", `${body.latency.medianMs}ms`);
  line("worst", `${body.latency.worstMs}ms`);

  console.log("\n  SETTINGS IN FORCE");
  for (const [name, value] of Object.entries(body.settings)) line(name, String(value));
  console.log("");
}

const what = process.argv[2] ?? "card";
if (what === "card") card();
else if (what === "score") await report();
else { console.error("usage: bun scripts/session-check.ts <card|score>"); process.exit(2); }
