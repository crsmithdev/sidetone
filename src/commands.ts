/**
 * The wake-word commands of spec section 9.
 *
 * 9.3 is the whole difficulty: the bridge matches the sound of the wake word,
 * not its spelling. A speech-to-text engine writes "sidetone" as "Side tone",
 * "side-tone", "Sitone" or "Cytone" depending on how it heard it. So the match
 * strips everything but the letters, closes up the spaces and allows a
 * character of difference, plus the forms the corpus found (config
 * wakeWordVariants).
 *
 * The same tolerance applies to the command that follows: a command is a set
 * of words to find, not a phrase to match exactly.
 */
export type CommandName =
  | "mute" | "unmute" | "clearContext" | "usage"
  | "restate" | "where" | "endTurn"
  | "tonesOn" | "tonesOff" | "musicOn" | "musicOff" | "stats"
  | "femaleVoice" | "maleVoice"
  | "carryOn" | "interruptOn" | "interruptOff"
  | "audioOn" | "audioOff"
  | "verbosityBrief" | "verbosityNormal" | "verbosityFull" | "shorter" | "longer";

export type Match =
  /** 9.4 a command to do */
  | { kind: "command"; name: CommandName }
  /** 9.7 the wake word came through but the command did not */
  | { kind: "unclear" }
  /** no wake word: this is a thing Chris said to the agent */
  | { kind: "speech" };

/**
 * Every command: the words that have to be there for it to match, and the
 * phrases the corpus is recorded from (ADR 0006). `any` is what the matcher
 * reads; `phrases` is what `scripts/heard-refresh.ts` says aloud, after the
 * wake word, and what `test/heard.test.ts` checks every command has. A
 * command with no phrase is a command that ships unheard, and four did.
 */
const COMMANDS: Array<{ name: CommandName; any: string[][]; phrases: string[] }> = [
  { name: "unmute", any: [["unmute"], ["un", "mute"], ["listen", "again"]], phrases: ["unmute"] },
  { name: "mute", any: [["mute"], ["stop", "listening"]], phrases: ["mute", "stop listening"] },
  // item 36 two words: "clear" alone is a word Chris says, and it cost the session
  { name: "clearContext", any: [["clear", "context"]], phrases: ["clear the context"] },
  { name: "usage", any: [["usage"], ["cost"], ["spent"]], phrases: ["report the usage"] },
  { name: "restate", any: [["restate"], ["say", "again"], ["repeat"]], phrases: ["say again"] },
  // item 36 no bare "where": "there", "here" and "were" are one character
  // from it, and this command drops a held answer. "where are" is the phrase
  // of 9.4.7 with the middle forgiven, which is how it ever worked.
  { name: "where", any: [["where", "are"], ["catch", "up"], ["recap"]], phrases: ["recap"] },
  // item 36 the on and off pairs come before endTurn: "on" is one character
  // from "in", so "turn the audio on" is "in turn" to that row.
  // item 36 no bare "tones": a toggle said blind leaves the tones in a state
  // nobody knows, and "tones off" beside it is the one that is meant.
  { name: "tonesOff", any: [["tones", "off"], ["tone", "off"], ["no", "tones"], ["sounds", "off"]], phrases: ["tones off"] },
  { name: "tonesOn", any: [["tones", "on"], ["tone", "on"], ["sounds", "on"]], phrases: ["tones on"] },
  /**
   * 11.12 the audio, which the app also has a button for. It is here because
   * that button was tapped by accident twice on 21 September and there was no
   * way back from the car: the bridge looked dead and only the journal said why.
   */
  { name: "audioOff", any: [["audio", "off"], ["voice", "off"], ["no", "audio"]], phrases: ["audio off"] },
  { name: "audioOn", any: [["audio", "on"], ["voice", "on"]], phrases: ["audio on"] },
  // 15.7.3 the hold music. "stop" is deliberately not a form: it ends the turn.
  { name: "musicOff", any: [["music", "off"]], phrases: ["music off"] },
  { name: "musicOn", any: [["music", "on"]], phrases: ["music on"] },
  // 11.9 the two ways to treat a question that lands mid-answer. No bare
  // "interrupt", for the same reason as the tones (item 36).
  { name: "interruptOff", any: [["interrupt", "off"], ["interrupting", "off"]], phrases: ["interrupt off"] },
  { name: "interruptOn", any: [["interrupt", "on"], ["interrupting", "on"]], phrases: ["interrupt on"] },
  // 9.3 "end the" elides, and every engine tried writes it as "in the turn"
  // "nevermind" is one word to the engine, and "end the" elides far enough
  // that "in the turn" and "and the turn" both come back
  // "sharp" is the one-word form, asked for in a car where the whole phrase is
  // too much to say. A five letter word forgives one character, so "share" and
  // "shard" end the turn as well; neither follows the wake word in practice.
  { name: "endTurn", any: [["end", "turn"], ["in", "turn"], ["stop"], ["cancel"], ["never", "mind"], ["nevermind"], ["sharp"]], phrases: ["end turn", "never mind"] },
  // "stets" is already within tolerance of "stats"; "steph" is not, and the
  // engine wrote it on a real run. "that's" is deliberately not accepted: it
  // is a word Chris says, and a wake word in front of it is no protection.
  { name: "stats", any: [["stats"], ["steph"], ["status"], ["latency"], ["diagnostics"], ["how", "fast"]], phrases: ["stats", "latency"] },
  // 11.10 the rest of an answer a barge-in took off the queue. Not
  // "continue": that is the agreement word of 10.3, and it has one job (item 36).
  { name: "carryOn", any: [["carry", "on"], ["go", "on"], ["the", "rest"]], phrases: ["carry on"] },
  // item 37 how much the agent says: a level by name, or one level either way
  { name: "verbosityBrief", any: [["verbosity", "brief"]], phrases: ["verbosity brief"] },
  { name: "verbosityNormal", any: [["verbosity", "normal"]], phrases: ["verbosity normal"] },
  { name: "verbosityFull", any: [["verbosity", "full"]], phrases: ["verbosity full"] },
  { name: "shorter", any: [["shorter"]], phrases: ["shorter"] },
  { name: "longer", any: [["longer"]], phrases: ["longer"] },
  { name: "femaleVoice", any: [["female"], ["woman"]], phrases: ["female voice"] },
  // 9.3 the forms the engine produces, not the spelling. small.en writes
  // "male voice" as "Mail Voice", and sometimes drops the second word, so
  // "mail" is one of the accepted forms and one word is enough. Requiring
  // "voice" was the first attempt and it matched nothing on a real run. No
  // "man": "can", "mean" and "an" are one character from it (item 36).
  { name: "maleVoice", any: [["male"], ["mail"]], phrases: ["male voice"] },
];

/** Letters and spaces only, collapsed: what the sound was, not how it was written. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z\s]/g, " ").replace(/\s+/g, " ").trim();
}

export function editDistance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        (previous[j] as number) + 1,
        (current[j - 1] as number) + 1,
        (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length] as number;
}

/** How much of a spelling difference to forgive: longer words earn more. */
function tolerance(word: string): number {
  return word.length <= 5 ? 1 : Math.min(3, Math.floor(word.length / 4));
}

/**
 * The wake word gets one character of tolerance, not the usual share. "side
 * note" is two characters from "sidetone" in spelling and nothing like it in
 * sound, and "Side note, ..." is a thing Chris says out loud.
 */
const WAKE_TOLERANCE = 1;

/** 9.1 a voice command starts with the wake word; only a false start may precede it. */
const WAKE_WINDOW = 2;

/**
 * The text after the wake word, or null when the wake word is not there.
 * The wake word may be anywhere: an engine often puts a false start in front.
 */
export function afterWakeWord(said: string, wakeWord: string, variants: string[] = []): string | null {
  const words = normalize(said).split(" ").filter(Boolean);
  const targets = [wakeWord, ...variants].map((form) => normalize(form).replace(/ /g, "")).filter(Boolean);
  if (targets.length === 0) return null;
  const span = Math.max(...[wakeWord, ...variants].map((form) => normalize(form).split(" ").length));
  // try the wake word as one word, then as the number of words it is written with
  for (let i = 0; i < Math.min(words.length, WAKE_WINDOW); i++) {
    for (let take = 1; take <= span && i + take <= words.length; take++) {
      const candidate = words.slice(i, i + take).join("");
      if (targets.some((target) => editDistance(candidate, target) <= WAKE_TOLERANCE)) return words.slice(i + take).join(" ");
      // 9.3 the engine runs them together: "Sidetonemute." is one token and
      // splitting on spaces never finds it. An exact prefix only -- forgiving
      // the spelling here as well would let half the language look like a
      // wake word with something stuck to it.
      for (const target of targets) {
        if (candidate.length > target.length && candidate.startsWith(target)) {
          return [candidate.slice(target.length), ...words.slice(i + take)].join(" ");
        }
      }
    }
  }
  return null;
}

/** 9.6 every command there is, so a setting that names one can be checked. */
export const COMMAND_NAMES: CommandName[] = COMMANDS.map((command) => command.name);

/** 18.8 every phrase the corpus is recorded from, with the wake word in front, and what each must reach. */
export function spokenForms(wakeWord: string): Array<{ said: string; want: CommandName }> {
  return COMMANDS.flatMap(({ name, phrases }) => phrases.map((phrase) => ({ said: `${wakeWord}, ${phrase}`, want: name })));
}

/**
 * Whether every word of a form is there, each in a spoken word of its own.
 * "one" is within tolerance of both "tone" and "on", so before the words were
 * kept apart "one more" turned the tones on (item 36).
 */
function found(targets: string[], words: string[], taken: number[] = []): boolean {
  if (targets.length === 0) return true;
  const [want, ...rest] = targets as [string, ...string[]];
  return words.some((word, i) => !taken.includes(i) && editDistance(word, want) <= tolerance(want) && found(rest, words, [...taken, i]));
}

/** 9.4 which command the words after the wake word name, if any. */
export function commandIn(rest: string): CommandName | null {
  const words = rest.split(" ").filter(Boolean);
  for (const { name, any } of COMMANDS) {
    if (any.some((all) => found(all, words))) return name;
  }
  return null;
}

/**
 * 9.5 two commands work while muted, and 9.6 makes that set a setting, so the
 * gate is a list lookup rather than a pair of names in the code. This is the
 * one place the rule is.
 */
function allowed(name: CommandName, muted: boolean, mutedCommands: string[]): boolean {
  return !muted || mutedCommands.includes(name);
}

export function match(said: string, wakeWord: string, muted: boolean, mutedCommands: string[], variants: string[] = []): Match {
  const rest = afterWakeWord(said, wakeWord, variants);
  if (rest === null) return { kind: "speech" };
  const name = commandIn(rest);
  if (name === null || !allowed(name, muted, mutedCommands)) return { kind: "unclear" };
  return { kind: "command", name };
}

/**
 * Short enough to be a command and nothing else.
 *
 * Inside the wake-word hold an utterance is matched with no wake word in front
 * of it, and the command table holds bare single words: `stop`, `mute`,
 * `mail`, `cost`. So "how do I stop the server" ended the turn and the question
 * never reached the agent. Measured 14 September, a command after the wake word
 * is one or two words -- the longest the card asks for is "tones off".
 */
const HOLD_WORDS = 3;

/** 10.2 the only words that may stand beside the agreement word, with the wake word and its forms. */
const BESIDE_AGREEMENT = ["okay", "ok", "yes", "yeah", "please", "sure", "go ahead"];

/**
 * 10.2 the agreement word said alone, or with only a plain yes or the wake
 * word beside it. Any other word, a negation first of all, is not agreement:
 * "do not continue" holds the word, and it agreed to a force push until 24 September.
 */
function agrees(plain: string, words: Words): boolean {
  const word = normalize(words.agreementWord);
  let rest = ` ${plain} `;
  if (!rest.includes(` ${word} `)) return false;
  rest = rest.replace(` ${word} `, " ");
  const wake = [words.wakeWord, ...words.wakeWordVariants].map(normalize).flatMap((form) => [form, form.replace(/ /g, "")]);
  const beside = [...BESIDE_AGREEMENT, ...wake].sort((a, b) => b.length - a.length);
  for (const form of beside) {
    while (rest.includes(` ${form} `)) rest = rest.replace(` ${form} `, " ");
  }
  return rest.trim() === "";
}

/** One utterance, read once: what it matched, and whether it is the agreement word (10.2). */
export type Reading = Match & { agreed: boolean };

/** What reading an utterance needs to know: the words of 9.2, 9.6 and 10.2, as the config names them. */
export interface Words {
  wakeWord: string;
  wakeWordVariants: string[];
  mutedCommands: string[];
  agreementWord: string;
}

/**
 * Every utterance goes through here, and only through here. `awaiting` is the
 * wake-word hold of 9.1: the wake word arrived a moment ago on its own, so a
 * short utterance with no wake word is its command. A longer one, or one that
 * names no command, is speech: a question asked after a false start must not
 * be swallowed.
 */
export function read(said: string, words: Words, muted: boolean, awaiting: boolean): Reading {
  const plain = normalize(said);
  // 10.3 a specific word, so a reflex or a bad transcription cannot say it
  const agreed = agrees(plain, words);
  const matched = match(said, words.wakeWord, muted, words.mutedCommands, words.wakeWordVariants);
  if (matched.kind === "speech" && awaiting && plain.split(" ").length <= HOLD_WORDS) {
    const name = commandIn(plain);
    if (name && allowed(name, muted, words.mutedCommands)) return { kind: "command", name, agreed };
  }
  return { ...matched, agreed };
}
