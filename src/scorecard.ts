/**
 * Scoring a drive against the script that was read (spec 18).
 *
 * The four numbers that matter are still waiting on a drive, and "it felt
 * better" is not a measurement. This turns a session into the same handful of
 * figures every time, so two builds can be compared rather than remembered.
 *
 * It scores what was recorded, not what happened: an utterance the bridge
 * never heard at all is invisible here, and shows up only as a command missing
 * from the tally.
 */
import type { Answered, Event, Heard, Matched } from "./diagnostics.ts";

/** The commands the card asks for, in the order it asks for them. */
export const SCRIPT: Array<{ say: string; expect: string }> = [
  { say: "hey bridge, stats", expect: "stats" },
  { say: "hey bridge, tones off", expect: "tonesOff" },
  { say: "hey bridge, tones on", expect: "tonesOn" },
  { say: "hey bridge, recap", expect: "where" },
  { say: "hey bridge, say again", expect: "restate" },
  { say: "hey bridge, mute", expect: "mute" },
  { say: "hey bridge, unmute", expect: "unmute" },
  { say: "hey bridge ... [wait two seconds] ... mute", expect: "mute" },
  { say: "hey bridge, unmute", expect: "unmute" },
];

/** The passage, read at a normal pace. One line is one breath. */
export const PASSAGE = [
  "The keeper rang the bell at four in the afternoon.",
  "On clear days the sound went out over flat water and returned nothing.",
  "He had been told twice that the station was decommissioned.",
];

export interface Scorecard {
  commands: { asked: number; fired: number; missed: string[]; wrong: Array<{ became: string; said: string }> };
  passage: { linesExpected: number; utterances: number; whole: number; fragments: number; accuracy: number };
  heard: { total: number; empty: number; tooQuiet: number; medianMs: number; medianPeak: number };
  /** 18.4 the round trips this drive closed, from the record rather than from memory */
  roundTrip: { rounds: number; medianMs: number; worstMs: number };
  bargeIns: number;
  invented: number;
}

const plain = (text: string) => text.toLowerCase().replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

/** How much of the line came back, word for word, ignoring order of nothing. */
export function wordAccuracy(said: string, heard: string): number {
  const want = plain(said).split(" ").filter(Boolean);
  const got = new Set(plain(heard).split(" ").filter(Boolean));
  if (want.length === 0) return 1;
  return want.filter((word) => got.has(word)).length / want.length;
}

export function score(events: Event[], script = SCRIPT, passage = PASSAGE): Scorecard {
  const heard = events.filter((e): e is Heard => e.kind === "heard");
  const matched = events.filter((e): e is Matched => e.kind === "matched");

  // commands, counted by what fired rather than by position: a missed one
  // would otherwise slide every step after it
  const wanted = new Map<string, number>();
  for (const step of script) wanted.set(step.expect, (wanted.get(step.expect) ?? 0) + 1);
  const fired = new Map<string, number>();
  for (const m of matched) if (wanted.has(m.became)) fired.set(m.became, (fired.get(m.became) ?? 0) + 1);
  const missed: string[] = [];
  for (const [name, count] of wanted) {
    for (let i = fired.get(name) ?? 0; i < count; i++) missed.push(name);
  }
  // a command phrase that reached the agent instead is the expensive failure
  const wrong = matched
    // the engine puts a comma in it as often as not: "Hey, BridgeMute."
    .filter((m) => m.became === "speech" && /hey[\s,.]*bridge|hay[\s,.]*bridge|cambridge/i.test(m.said))
    .map((m) => ({ became: m.became, said: m.said }));

  // the passage: one utterance a line is whole, more than that is chopped
  const lines = passage.map(plain);
  const forPassage = heard.filter((h) => lines.some((line) => wordAccuracy(line, h.text) >= 0.35));
  const accuracies = lines.map((line) => {
    const best = forPassage.map((h) => wordAccuracy(line, h.text)).sort((a, b) => b - a)[0] ?? 0;
    return best;
  });

  const ms = heard.map((h) => h.ms).sort((a, b) => a - b);
  const peaks = heard.map((h) => h.peak).sort((a, b) => a - b);
  const answers = events.filter((e): e is Answered => e.kind === "answered").map((a) => a.answerMs);
  return {
    commands: { asked: script.length, fired: script.length - missed.length, missed, wrong },
    passage: {
      linesExpected: passage.length,
      utterances: forPassage.length,
      whole: accuracies.filter((a) => a >= 0.8).length,
      fragments: Math.max(0, forPassage.length - passage.length),
      accuracy: round(accuracies.reduce((sum, a) => sum + a, 0) / (accuracies.length || 1)),
    },
    heard: {
      total: heard.length,
      empty: heard.filter((h) => !h.text).length,
      tooQuiet: heard.filter((h) => !h.text && h.transcribeMs === 0).length,
      medianMs: middle(ms),
      medianPeak: middle(peaks),
    },
    roundTrip: {
      rounds: answers.length,
      medianMs: Math.round(middle([...answers].sort((a, b) => a - b))),
      worstMs: answers.reduce((worst, ms) => Math.max(worst, ms), 0),
    },
    bargeIns: events.filter((e) => e.kind === "barged").length,
    // A turn from something nobody said, judged against this session rather
    // than against a number. The real one, "Thank you.", peaked at 0.12 where
    // the session's speech sat at 0.48: a quarter of it. An absolute threshold
    // looked right on that session and then called every utterance of a
    // quieter one an invention, which is how this rule was found to be wrong.
    invented: invented(heard),
  };
}

/**
 * Text from an utterance far quieter than the ones around it. Relative,
 * because a phone at arm's length and a phone in a cradle are different
 * recordings of the same voice and neither is the wrong one.
 */
const QUIET_SHARE = 0.45;

function invented(heard: Heard[]): number {
  const spoken = heard.filter((h) => h.text);
  if (spoken.length < 4) return 0;
  const median = middle(spoken.map((h) => h.peak).sort((a, b) => a - b));
  if (median <= 0) return 0;
  return spoken.filter((h) => h.peak < median * QUIET_SHARE).length;
}

function middle(sorted: number[]): number {
  if (sorted.length === 0) return 0;
  const at = Math.floor(sorted.length / 2);
  return round(sorted.length % 2 ? (sorted[at] as number) : ((sorted[at - 1] as number) + (sorted[at] as number)) / 2);
}

function round(value: number): number {
  return Number(value.toFixed(3));
}
