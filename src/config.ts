/**
 * Every default in the spec is a setting (spec 6.7). This file is the whole of
 * section 21: a builder does not write one of these values into the code.
 *
 * Read from $SIDETONE_CONFIG, else ~/.sidetone/config.json. A missing
 * file is fine; a present one overrides field by field.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { COMMAND_NAMES, type CommandName } from "./commands.ts";
import { ENGINES } from "./speech.ts";
import { homedir } from "node:os";
import { join } from "node:path";

/** Item 37 how much the agent says, shortest first. */
export const VERBOSITIES = ["brief", "normal", "full"] as const;
export type Verbosity = typeof VERBOSITIES[number];

export interface Config {
  /** 8.4.3 no activity on any channel for this long and the process is dead */
  silenceMs: number;
  /** 8.5.2 more than this many compactions inside the window is a definite fault */
  compactionLimit: number;
  compactionWindowMs: number;
  /** 8.7.2 process memory, not context: a leak, not normal work */
  memoryRecycleBytes: number;
  /** 8.6.9 the ceiling ladder: ask, then interrupt, then restart */
  ceilingMs: number;
  checkpointWindowMs: number;
  graceMs: number;
  /** 8.11 final, and still a setting */
  model: string;
  /** 9.2 matched by sound, not spelling (9.3) */
  wakeWord: string;
  /** 9.3 the other things the engine writes when it hears the wake word (18.8) */
  wakeWordVariants: string[];
  /**
   * 9.1 how long the bridge waits for the command after hearing the wake word
   * on its own. Measured 14 September: Chris leaves about 1.6 seconds between
   * "sidetone" and what follows, which is longer than the end-of-turn pause,
   * so the two arrive as separate utterances and neither works alone.
   */
  wakeHoldMs: number;
  /**
   * 11.9 what a question does to a turn that is still running. False holds the
   * answer and refuses the question, which protects an answer already paid for
   * from a sentence that was not meant for the bridge. True stops the answer
   * and asks the question, which is the Claude app's feel (11.6). Chris turns
   * it over out loud, mid-drive, because only the car says which is right.
   */
  interruptOnSpeech: boolean;
  /**
   * The quietest an utterance may peak and still be treated as speech. Whisper
   * writes words for near-silence even with the voice detector on: "Thank you."
   * came out of a recording that peaked at 0.12 and cost a turn. Real speech in
   * the same session peaked between 0.43 and 0.55.
   */
  minSpeechPeak: number;
  /** 9.5 the only two commands that work while muted; a list so it can grow (9.6) */
  mutedCommands: CommandName[];
  /** 10.2 a specific word, never "yes" */
  agreementWord: string;
  /** 2.3 how long a tool call must run before the bridge says what it is */
  narrationDelayMs: number;
  /** 4.5 the whole voice path is local; these name local engines only (4.8) */
  pythonBin: string;
  modelsDir: string;
  /** 4.6 a small Whisper-family model */
  sttModel: string;
  /**
   * 4.9 which engine speaks. kokoro is on the GPU; piper is the CPU fallback;
   * chatterbox clones a voice from a recording and costs twenty times kokoro.
   */
  ttsEngine: "kokoro" | "piper" | "chatterbox";
  /**
   * 4.9 the voice, named the way the chosen engine names its voices. Kokoro
   * names a pack; chatterbox names a wav under `chatterboxRefs`.
   */
  ttsVoice: string;
  /**
   * 9.4 the two Chris switches between out loud. Kokoro keeps all its voices
   * in one pack, so a switch is a different name on the next request. Each
   * engine names its own voices: a file that names the engine and not the
   * voices gets that engine's pair, not the default engine's.
   */
  voiceChoices: { female: string; male: string };
  /**
   * Kokoro runs in its own environment: onnxruntime wants the CUDA 13 wheels
   * and ctranslate2, which carries whisper, wants the CUDA 12 ones, and both
   * unpack into the same directory.
   */
  kokoroPythonBin: string;
  kokoroModel: string;
  kokoroVoices: string;
  /**
   * Chatterbox is a third environment, for the same reason kokoro is a second
   * one: it pins its own torch, and the pinned one has no kernels for this
   * card. `chatterboxRefs` holds one wav per voice, named the way `ttsVoice`
   * names it.
   */
  chatterboxPythonBin: string;
  chatterboxRefs: string;
  /**
   * How much the voice performs the line, and how hard it is pulled back
   * toward the reference recording. 0.5 and 0.5 are the engine's own defaults
   * and the pair the voices were chosen at.
   */
  chatterboxExaggeration: number;
  chatterboxCfg: number;
  /**
   * Where the bridge keeps its own sentences once it has said them, so an
   * acknowledgement lands at once rather than after a synthesis. Emptying it
   * costs nothing: what is missing is made again, and `warm` makes all of it.
   */
  spokenDir: string;
  /**
   * 11.6.1 how many takes `warm` makes of a fixed reply before it gives up on
   * saying it alone. The cloning voice garbles a reply of one word most of the
   * time: "Stopped." came out clean in 1 take of 10 on 24 September. A take of
   * a short reply costs about a second of the GPU, once, offline, so 100 takes
   * is under two minutes, and finds a reply that comes out clean once in fifty
   * takes seven times in eight. A reply it still has not found is made inside
   * a carrier (11.6.3), with the same number of tries.
   */
  warmTries: number;
  /**
   * 11.6.5 the short kept lines, one of which plays at the start of an answer
   * while its first sentence is made. An empty list turns them off. "Mm-hm."
   * is not on it: the check and the carrier cut match words, and the speech
   * worker has no one spelling for it, so no take of it can be kept.
   */
  openers: string[];
  /**
   * 18.14 whether the bridge keeps a copy of each clip it sends, and where.
   * It stores speech, so it is a setting. It is on while the garbled speech
   * of 23 September is open (todo item 33).
   */
  keepSentClips: boolean;
  sentDir: string;
  /** 5.6 a run of text this long with no punctuation is spoken anyway */
  sentenceMaxChars: number;
  /** 11.5 the pause that ends a turn, and the level that counts as speech */
  endOfTurnPauseMs: number;
  /**
   * 18.4 the quiet after which the recording so far is transcribed on the
   * guess that the turn has ended. The end-of-turn pause still decides; this
   * only starts the engine early, so the text is usually in hand when the
   * pause runs out. A wrong guess costs one transcription and nothing Chris
   * hears. Zero turns it off.
   */
  earlyTranscribeMs: number;
  /**
   * 18.16 the turn detector, Pipecat Smart Turn v3 on the CPU. "shadow" asks
   * it at each tentative end and writes its guess to the record; the pause
   * still ends every turn. It stays off, after one line in the journal, when
   * its worker does not load. "off" does not start the worker.
   */
  turnDetector: "off" | "shadow";
  /** 18.16 the model file, from Hugging Face pipecat-ai/smart-turn-v3 */
  turnModel: string;
  /** the level that counts as speech, as a fraction of full scale */
  speechLevel: number;
  /** how long the level must stay up before the bridge treats it as speech */
  speechOnsetMs: number;
  /**
   * 11.3 barge-in is a second, stricter detector. Starting a recording is
   * cheap and wrong rarely costs anything; cutting the bridge off mid-sentence
   * on a lorry going past is the fault the car test found. So a barge-in wants
   * a louder sound, held for longer, than the level that opens a recording.
   */
  bargeInLevel: number;
  bargeInMs: number;
  /**
   * How long a dip may last before it counts as the end of speech. Natural
   * speech drops below the level between syllables, so without this a short
   * command never reaches bargeInMs and only long sentences barge in.
   */
  bargeInGapMs: number;
  /**
   * 11.3 the one clock in the hold. A barge-in keeps the sentences until the
   * bridge knows what Chris said; this covers only the case where the
   * transcription never comes back at all.
   */
  holdBackstopMs: number;
  /** 6.5 the voice instruction lives in the bridge, not in the aleph identity file */
  voiceInstruction: string;
  /**
   * Item 37 how much the agent says: brief is one or two sentences and only
   * the result, normal is the behaviour from before the setting, full gives
   * the reasoning and more detail. The bridge names it in every turn's prompt.
   */
  verbosity: Verbosity;
  /** 15.4 the cues are mostly a debugging aid, so they can be turned off by voice */
  tones: boolean;
  /** 15.6 how loud a cue is, as a fraction of full scale */
  cueVolume: number;
  /** 15.5 how long a wait has to be before a cue is worth playing */
  audioCueDelayMs: number;
  /** 15.2 how often the cue repeats while the wait goes on */
  audioCueEveryMs: number;
  /**
   * 15.7 how long a long turn may be silent before the hold music plays. A
   * long turn is one whose reply starts with `[long]` (15.7.4). The silence is
   * measured from the later of the hand-over to the agent and the end of the
   * last sentence. Zero turns the music off.
   */
  holdMusicAfterMs: number;
  /** 15.7.3 whether the hold music plays at all, so it can be turned off by voice */
  holdMusic: boolean;
  /** 11.12.3 whether the bridge makes any sound. It is kept across restarts, as the hold music is. */
  audio: boolean;
  /** 15.8 the folder of tracks: every audio file in it, in file-name order. Not in the repository. */
  holdMusicFolder: string;
  /** 15.9 how loud the track is, as a factor on the file. The voice is 1. */
  holdMusicGain: number;
  /** 15.10.2 how long the track takes to fade out when a sentence stops it. Zero cuts it at once. */
  holdMusicFadeMs: number;
  /** 15.10.4 how long each start of a track takes to rise from nothing to full level. Zero starts it at full level. */
  holdMusicFadeInMs: number;
  /** 13.2 the reported rate-limit use that earns a spoken warning */
  usageWarnFraction: number;
  /**
   * 14.1 how long to keep trying livekit at startup. On a boot the unit is
   * ordered after docker, and docker being up does not mean the container
   * inside it is listening yet.
   */
  livekitWaitMs: number;
  /** 4.1 the transport. Empty keys mean the pair in ~/.sidetone/keys.json. */
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  livekitPort: number;
  /** the address the phone uses. Empty means the tailnet address, else this machine's. */
  advertiseHost: string;
  /**
   * 12.1 A browser gives no microphone to a page that is not a secure context,
   * and only loopback is exempt. A phone therefore needs https, and an https
   * page may only open a wss socket. Either terminate TLS in front of the
   * bridge and set these two, or give the bridge a certificate below.
   */
  publicOrigin: string;
  livekitPublicUrl: string;
  tlsCert: string;
  tlsKey: string;
  /** 12.1 the port the bridge serves the client and the pairing on */
  servePort: number;
  /** the room the bridge and the phone meet in */
  room: string;
  /** 12.2 how long the token the client keeps stays good */
  tokenDays: number;
  /** 14.8 how far back "the turns it missed" reaches. A drop in a tunnel is minutes. */
  historyMaxAgeMs: number;
  /**
   * 18 where the drive record is appended. The scorecard reads it back, and it
   * is on disk rather than in memory because a restart used to take a drive
   * with it.
   */
  recordPath: string;
  /** 6.1 the bridge starts Claude Code in the project directory */
  claudeBin: string;
  claudeArgs: string[];
}

export const DEFAULTS: Config = {
  silenceMs: 60_000,
  compactionLimit: 3,
  compactionWindowMs: 300_000,
  memoryRecycleBytes: 4 * 1024 ** 3,
  ceilingMs: 600_000,
  checkpointWindowMs: 15_000,
  graceMs: 30_000,
  model: "sonnet",
  wakeWord: "sidetone",
  // 9.3 the forms small.en writes for "sidetone", from the corpus of 20
  // September: "side tone" a third of the time, and the rest when the /d/ goes
  // under road noise. 18.8 says find them by use; "side don't" and "site on"
  // came from the -5 dB rows. Each needs a command after it to do anything.
  wakeWordVariants: ["side tone", "sigh tone", "sight tone", "cytone", "sitone", "site on", "side don't"],
  wakeHoldMs: 6_000,
  interruptOnSpeech: false,
  minSpeechPeak: 0.15,
  mutedCommands: ["mute", "unmute", "tonesOn", "tonesOff"],
  agreementWord: "continue",
  narrationDelayMs: 5_000,
  pythonBin: new URL("../.venv/bin/python", import.meta.url).pathname,
  modelsDir: join(homedir(), ".sidetone", "models"),
  sttModel: "small.en",
  ttsEngine: "chatterbox",
  // 4.9 the engine names its voices; the table in speech.ts is the one place they are written
  ...ENGINES.chatterbox.voices,
  kokoroPythonBin: join(homedir(), ".sidetone", "kokoro-venv", "bin", "python"),
  kokoroModel: join(homedir(), ".sidetone", "models", "kokoro", "kokoro-v1.0.onnx"),
  kokoroVoices: join(homedir(), ".sidetone", "models", "kokoro", "voices-v1.0.bin"),
  chatterboxPythonBin: join(homedir(), ".sidetone", "chatterbox-venv", "bin", "python"),
  chatterboxRefs: join(homedir(), ".sidetone", "models", "chatterbox", "refs"),
  chatterboxExaggeration: 0.5,
  chatterboxCfg: 0.5,
  spokenDir: join(homedir(), ".sidetone", "spoken"),
  warmTries: 100,
  openers: ["Okay.", "Right.", "Sure.", "Got it.", "Alright.", "Let me see.", "One moment."],
  keepSentClips: true,
  sentDir: join(homedir(), ".sidetone", "sent"),
  sentenceMaxChars: 240,
  endOfTurnPauseMs: 1_500,
  earlyTranscribeMs: 400,
  turnDetector: "shadow",
  turnModel: join(homedir(), ".cache", "sidetone", "smart-turn", "smart-turn-v3.2-cpu.onnx"),
  speechLevel: 0.02,
  speechOnsetMs: 50,
  // 2.5 times the level and 8 times the length of the recording detector.
  // A starting point, not a measured one: 18.6 settles it on a drive.
  bargeInLevel: 0.05,
  bargeInMs: 400,
  bargeInGapMs: 200,
  holdBackstopMs: 10_000,
  /**
   * 6.6 is two rules wearing one coat, and only one of them may bend.
   *
   * Never reading a path, a diff, code or a secret aloud is a safety rule and
   * it yields to nothing. Being brief is a style rule, and it is the only
   * thing the story pipeline collides with when it wants a candidate read out
   * in full (2.8.2). Phrasing the style rule as an absolute is what left a
   * project no way to say otherwise; 6.1 already gives a project its voice,
   * in its own instructions file, and this lets that voice be heard.
   *
   * The rule about paths was too strict and is now a default about absolute
   * paths only. It is worded as a default because that is what it is: asked
   * outright for the absolute path, the agent gives it, and an absolute the
   * model routinely ignores teaches it that the rules above are soft too.
   * Spoken by the voice and transcribed back: "src/audio.ts" takes 3.0 seconds
   * and is understood as "SRC slash audio, TS", which is how a person says it.
   * The absolute path it came from takes 6.6 seconds and arrives as "slash home
   * slash CRSMI slash sidetone slash SRC slash audio TS", which is the
   * thing 6.6 was written to prevent. The directory is worth keeping: src,
   * test and scripts are not interchangeable.
   */
  voiceInstruction: [
    // 18 September: the agent told Chris twice that this conversation was a
    // separate session from the bridge under test, and `ps` says it was not.
    // It did not lack reasoning, it lacked a fact. This is the fact.
    "You are the agent Sidetone runs. This conversation reaches Chris as speech, through the bridge, from this machine. Do not tell him it is a separate session or a different channel.",
    "You are in a spoken conversation. A text to speech engine reads your reply aloud.",
    "Never read diffs, code or secrets aloud. Summarize those instead. This rule does not bend.",
    "Name a file by its path from the project root, like src/audio.ts. Do not speak an absolute path unless you are asked for one.",
    "Otherwise answer in short plain sentences, without markdown, lists, headers or code blocks.",
    // 18.4 the first sentence is on the critical path: the voice cannot start
    // until the collector has one, and a long opening sentence is a long wait.
    "Begin every answer with one short sentence, so the voice can start at once.",
    // 21 September: the bridge used to guess from the silence that a turn was
    // long, and the guess came after the wait. The agent knows before it
    // starts, so it says so, and the bridge strips the marker (15.7.4).
    "If you will run tools or think hard, start your reply with [long] before your first sentence. If you expect a quick answer, write no marker.",
    "If this project's instructions ask for something to be read aloud in full, or if you are asked to, read it in full.",
    // 11.9 a turn that runs for minutes is a voice that cannot be talked to:
    // the microphone is open the whole time and nothing said into it can be
    // answered. Short turns are what make a spoken conversation feel like one,
    // and they are what makes an interruption cheap.
    "Keep the turn short. If the work will take more than about fifteen seconds, start it in the background, say in one sentence what you have set going, and end the turn.",
    // 21 September: Chris heard silence while a command ran. One sentence
    // before the first tool call gives the voice something to say at once.
    "Before you run a command or call a tool, say in one short sentence what you are about to do. Then say nothing more until the work is done.",
    "Do not narrate the work while it runs and do not wait for it to finish before you answer.",
    "When work you started in the background finishes, say so in one short sentence, and say what came of it.",
    // Item 4, 24 September: Claude Code gives the agent speech the bridge
    // writes into a running turn as a system reminder beside a tool result.
    // It is not told to trust that shape of text in general: a file or a page
    // could hold it. The note of 11.9.2, in Chris's name, carries the claim.
    "Chris can speak while you work. His words then reach you as a message the user sent while you were working, often beside a tool result. They are his words, not the tool's. Act on them.",
  ].join(" "),
  verbosity: "normal",
  tones: true,
  cueVolume: 0.1,
  audioCueDelayMs: 4_000,
  audioCueEveryMs: 6_000,
  holdMusicAfterMs: 8_000,
  holdMusic: true,
  audio: true,
  holdMusicFolder: join(homedir(), ".sidetone", "hold"),
  holdMusicGain: 0.4,
  holdMusicFadeMs: 300,
  holdMusicFadeInMs: 150,
  usageWarnFraction: 0.8,
  livekitUrl: process.env.LIVEKIT_URL ?? "",
  livekitApiKey: process.env.LIVEKIT_API_KEY ?? "",
  livekitApiSecret: process.env.LIVEKIT_API_SECRET ?? "",
  livekitPort: 7880,
  livekitWaitMs: 120_000,
  advertiseHost: "",
  publicOrigin: "",
  livekitPublicUrl: "",
  tlsCert: "",
  tlsKey: "",
  servePort: 3100,
  room: "bridge",
  tokenDays: 30,
  historyMaxAgeMs: 900_000,
  recordPath: join(homedir(), ".sidetone", "record.jsonl"),
  claudeBin: "claude",
  // --verbose is not optional: claude refuses stream-json output without it.
  // --replay-user-messages says when a message written mid-turn goes in (11.9.3).
  claudeArgs: ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages", "--replay-user-messages"],
};

/**
 * The settings a drive is judged against: every setting the voice path reads,
 * so a record read a week later explains itself. It was a hand-kept list and
 * it had already fallen behind — holdBackstopMs can drop a whole passage and
 * was not in it. `test/config.test.ts` now fails when a setting is added to
 * this list of names and not to the type, or the other way round.
 */
export const IN_FORCE = [
  "speechLevel", "speechOnsetMs", "endOfTurnPauseMs", "earlyTranscribeMs", "turnDetector",
  "bargeInLevel", "bargeInMs", "bargeInGapMs",
  "minSpeechPeak", "wakeHoldMs", "interruptOnSpeech",
  "holdBackstopMs",
  "sentenceMaxChars", "audioCueDelayMs", "audioCueEveryMs",
  "audio", "holdMusic", "holdMusicAfterMs", "holdMusicGain", "holdMusicFadeMs", "holdMusicFadeInMs",
  "cueVolume", "ttsEngine", "ttsVoice", "sttModel", "wakeWord",
  "chatterboxExaggeration", "chatterboxCfg", "verbosity", "tones",
] as const satisfies ReadonlyArray<keyof Config>;

export function settingsInForce(config: Config): Record<string, unknown> {
  return Object.fromEntries(IN_FORCE.map((key) => [key, config[key]]));
}

/**
 * 9.4 a setting Chris changed out loud outlives the process. "interrupt on"
 * used to live in memory alone: the restart of 18 September turned it off and
 * said nothing, and every refusal after that looked like the fault under test.
 * The file keeps only what was set, so a default that moves still moves.
 */
export function saveSettings(patch: Partial<Config>, path = configPath()): void {
  let current: Record<string, unknown> = {};
  try { current = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>; } catch { /* no file yet, or not ours to read: start from the patch */ }
  writeFileSync(path, `${JSON.stringify({ ...current, ...patch }, null, 2)}\n`);
}

export function configPath(): string {
  return process.env.SIDETONE_CONFIG ?? join(homedir(), ".sidetone", "config.json");
}

export function loadConfig(path = configPath()): Config {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return { ...DEFAULTS }; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${path} is not valid JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} must hold an object`);
  const given = parsed as Partial<Config>;
  const engine = given.ttsEngine ?? DEFAULTS.ttsEngine;
  const voices = ENGINES[engine]?.voices;
  if (!voices) throw new Error(`ttsEngine must be one of ${Object.keys(ENGINES).join(", ")}, not ${String(engine)}`);
  // 4.9 a voice the file did not name is the named engine's own, not the default engine's
  return checkConfig({ ...DEFAULTS, ...voices, ...given });
}

/**
 * The rules a config has to meet, whether it was read from the file or changed
 * while the bridge runs (item 44). One function for both, because a value the
 * bridge takes live goes into the file, and the next start reads it back.
 */
export function checkConfig(merged: Config): Config {
  for (const key of ["silenceMs", "ceilingMs", "checkpointWindowMs", "graceMs", "compactionWindowMs", "narrationDelayMs"] as const) {
    if (typeof merged[key] !== "number" || !(merged[key] > 0)) throw new Error(`${key} must be a positive number of milliseconds`);
  }
  // 10.3 a reflex or a bad transcription must not be able to say the agreement word
  if (!merged.agreementWord || merged.agreementWord.toLowerCase() === "yes") {
    throw new Error('agreementWord must be a specific word, and must not be "yes"');
  }
  /**
   * 11.3 the two detectors only make sense one way round: a barge-in is a
   * louder sound, held for longer, than the one that opens a recording. Set
   * them the other way and every recording is a barge-in, which is the fault
   * the car test found, arriving as "it cuts me off" rather than as an error.
   */
  if (merged.bargeInLevel <= merged.speechLevel) {
    throw new Error(`bargeInLevel (${merged.bargeInLevel}) must be louder than speechLevel (${merged.speechLevel})`);
  }
  // 18.4 a guess made after the pause has run is no guess at all
  if (merged.earlyTranscribeMs >= merged.endOfTurnPauseMs) {
    throw new Error(`earlyTranscribeMs (${merged.earlyTranscribeMs}) must be shorter than endOfTurnPauseMs (${merged.endOfTurnPauseMs})`);
  }
  if (merged.bargeInMs <= merged.speechOnsetMs) {
    throw new Error(`bargeInMs (${merged.bargeInMs}) must be longer than speechOnsetMs (${merged.speechOnsetMs})`);
  }
  // 4.6 the invention guard is a peak, and a peak under the speech level would
  // throw away every utterance the detector just accepted
  if (merged.minSpeechPeak <= merged.speechLevel) {
    throw new Error(`minSpeechPeak (${merged.minSpeechPeak}) must be louder than speechLevel (${merged.speechLevel})`);
  }
  if (!Number.isInteger(merged.warmTries) || merged.warmTries < 1) {
    throw new Error(`warmTries (${String(merged.warmTries)}) must be a whole number of at least one`);
  }
  if (typeof merged.holdMusicFadeInMs !== "number" || !(merged.holdMusicFadeInMs >= 0)) {
    throw new Error(`holdMusicFadeInMs (${String(merged.holdMusicFadeInMs)}) must be zero or a positive number of milliseconds`);
  }
  if (merged.turnDetector !== "off" && merged.turnDetector !== "shadow") {
    throw new Error(`turnDetector must be off or shadow, not ${String(merged.turnDetector)}`);
  }
  if (!VERBOSITIES.includes(merged.verbosity)) {
    throw new Error(`verbosity must be one of ${VERBOSITIES.join(", ")}, not ${String(merged.verbosity)}`);
  }
  // 9.6 the muted set is a list of commands, and a typo in it is a command
  // that quietly stops working while muted
  for (const name of merged.mutedCommands) {
    if (!COMMAND_NAMES.includes(name)) throw new Error(`mutedCommands has ${name}, which is not a command`);
  }
  return merged;
}
