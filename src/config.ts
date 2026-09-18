/**
 * Every default in the spec is a setting (spec 6.7). This file is the whole of
 * section 21: a builder does not write one of these values into the code.
 *
 * Read from $VOICE_BRIDGE_CONFIG, else ~/.voice-bridge/config.json. A missing
 * file is fine; a present one overrides field by field.
 */
import { readFileSync } from "node:fs";
import { COMMAND_NAMES, type CommandName } from "./commands.ts";
import { homedir } from "node:os";
import { join } from "node:path";

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
   * "hey bridge" and what follows, which is longer than the end-of-turn pause,
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
  /** 4.9 which engine speaks. kokoro is on the GPU; piper is the CPU fallback. */
  ttsEngine: "kokoro" | "piper";
  /** 4.9 the voice, named the way the chosen engine names its voices */
  ttsVoice: string;
  /**
   * 9.4 the two Chris switches between out loud. Kokoro keeps all its voices
   * in one pack, so a switch is a different name on the next request.
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
  /** 5.6 a run of text this long with no punctuation is spoken anyway */
  sentenceMaxChars: number;
  /** 11.5 the pause that ends a turn, and the level that counts as speech */
  endOfTurnPauseMs: number;
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
  /** how long to let the speakers drain before listening again, so the bridge does not hear itself */
  listenSettleMs: number;
  /** 6.5 the voice instruction lives in the bridge, not in the aleph identity file */
  voiceInstruction: string;
  /** 15.4 the cues are mostly a debugging aid, so they can be turned off by voice */
  tones: boolean;
  /** 15.6 how loud a cue is, as a fraction of full scale */
  cueVolume: number;
  /** 15.5 how long a wait has to be before a cue is worth playing */
  audioCueDelayMs: number;
  /** 15.2 how often the cue repeats while the wait goes on */
  audioCueEveryMs: number;
  /** 13.2 the reported rate-limit use that earns a spoken warning */
  usageWarnFraction: number;
  /**
   * 14.1 how long to keep trying livekit at startup. On a boot the unit is
   * ordered after docker, and docker being up does not mean the container
   * inside it is listening yet.
   */
  livekitWaitMs: number;
  /** 4.1 the transport. Empty keys mean the pair in ~/.voice-bridge/keys.json. */
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
  wakeWord: "hey bridge",
  // small.en writes "hey bridge" as "Cambridge" about half the time. 9.3 says
  // the bridge accepts the forms the engine produces; 18.8 says find them by use.
  wakeWordVariants: ["cambridge"],
  wakeHoldMs: 6_000,
  interruptOnSpeech: false,
  minSpeechPeak: 0.15,
  mutedCommands: ["mute", "unmute", "tones", "tonesOn", "tonesOff"],
  agreementWord: "continue",
  narrationDelayMs: 5_000,
  pythonBin: new URL("../.venv/bin/python", import.meta.url).pathname,
  modelsDir: join(homedir(), ".voice-bridge", "models"),
  sttModel: "small.en",
  ttsEngine: "kokoro",
  ttsVoice: "bf_emma",
  voiceChoices: { female: "bf_emma", male: "bm_daniel" },
  kokoroPythonBin: join(homedir(), ".voice-bridge", "kokoro-venv", "bin", "python"),
  kokoroModel: join(homedir(), ".voice-bridge", "models", "kokoro", "kokoro-v1.0.onnx"),
  kokoroVoices: join(homedir(), ".voice-bridge", "models", "kokoro", "voices-v1.0.bin"),
  sentenceMaxChars: 240,
  endOfTurnPauseMs: 1_500,
  speechLevel: 0.02,
  speechOnsetMs: 50,
  // 2.5 times the level and 8 times the length of the recording detector.
  // A starting point, not a measured one: 18.6 settles it on a drive.
  bargeInLevel: 0.05,
  bargeInMs: 400,
  bargeInGapMs: 200,
  holdBackstopMs: 10_000,
  listenSettleMs: 300,
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
   * slash CRSMI slash VoiceBridgeMCP slash SRC slash audio TS", which is the
   * thing 6.6 was written to prevent. The directory is worth keeping: src,
   * test and scripts are not interchangeable.
   */
  voiceInstruction: [
    "You are in a spoken conversation. A text to speech engine reads your reply aloud.",
    "Never read diffs, code or secrets aloud. Summarize those instead. This rule does not bend.",
    "Name a file by its path from the project root, like src/audio.ts. Do not speak an absolute path unless you are asked for one.",
    "Otherwise answer in short plain sentences, without markdown, lists, headers or code blocks.",
    "If this project's instructions ask for something to be read aloud in full, or if you are asked to, read it in full.",
    // 11.9 a turn that runs for minutes is a voice that cannot be talked to:
    // the microphone is open the whole time and nothing said into it can be
    // answered. Short turns are what make a spoken conversation feel like one,
    // and they are what makes an interruption cheap.
    "Keep the turn short. If the work will take more than about fifteen seconds, start it in the background, say in one sentence what you have set going, and end the turn.",
    "Do not narrate the work while it runs and do not wait for it to finish before you answer.",
  ].join(" "),
  tones: true,
  cueVolume: 0.12,
  audioCueDelayMs: 4_000,
  audioCueEveryMs: 6_000,
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
  recordPath: join(homedir(), ".voice-bridge", "record.jsonl"),
  claudeBin: "claude",
  // --verbose is not optional: claude refuses stream-json output without it
  claudeArgs: ["-p", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--include-partial-messages"],
};

/**
 * The settings a drive is judged against: every setting the voice path reads,
 * so a record read a week later explains itself. It was a hand-kept list and
 * it had already fallen behind — holdBackstopMs can drop a whole passage and
 * was not in it. `test/config.test.ts` now fails when a setting is added to
 * this list of names and not to the type, or the other way round.
 */
export const IN_FORCE = [
  "speechLevel", "speechOnsetMs", "endOfTurnPauseMs",
  "bargeInLevel", "bargeInMs", "bargeInGapMs",
  "minSpeechPeak", "wakeHoldMs", "interruptOnSpeech", "holdBackstopMs", "listenSettleMs",
  "sentenceMaxChars", "audioCueDelayMs", "audioCueEveryMs",
  "cueVolume", "ttsEngine", "ttsVoice", "sttModel", "wakeWord",
] as const satisfies ReadonlyArray<keyof Config>;

export function settingsInForce(config: Config): Record<string, unknown> {
  return Object.fromEntries(IN_FORCE.map((key) => [key, config[key]]));
}

export function configPath(): string {
  return process.env.VOICE_BRIDGE_CONFIG ?? join(homedir(), ".voice-bridge", "config.json");
}

export function loadConfig(path = configPath()): Config {
  let text: string;
  try { text = readFileSync(path, "utf8"); } catch { return { ...DEFAULTS }; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${path} is not valid JSON`); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${path} must hold an object`);
  const merged: Config = { ...DEFAULTS, ...(parsed as Partial<Config>) };
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
  if (merged.bargeInMs <= merged.speechOnsetMs) {
    throw new Error(`bargeInMs (${merged.bargeInMs}) must be longer than speechOnsetMs (${merged.speechOnsetMs})`);
  }
  // 4.6 the invention guard is a peak, and a peak under the speech level would
  // throw away every utterance the detector just accepted
  if (merged.minSpeechPeak <= merged.speechLevel) {
    throw new Error(`minSpeechPeak (${merged.minSpeechPeak}) must be louder than speechLevel (${merged.speechLevel})`);
  }
  // 9.6 the muted set is a list of commands, and a typo in it is a command
  // that quietly stops working while muted
  for (const name of merged.mutedCommands) {
    if (!COMMAND_NAMES.includes(name)) throw new Error(`mutedCommands has ${name}, which is not a command`);
  }
  return merged;
}
