/**
 * The bridge, assembled: the engines, the mouth, the conversation, the ear and
 * the control channel, joined once.
 *
 * The room and the desk each built this by hand, in the same order, and the
 * copies drifted: the desk built a bookkeeper with no record behind it, and
 * three commits in a week touched both.
 *
 * The tests then drifted the same way, for the same reason: the engines were
 * made in here, so no test could call this, and three harnesses built the
 * wiring again by hand. One of them wired the mouth's `talking` to a flag on
 * its fake source, where the room wires it to the ear. So `Parts` names
 * everything that differs between the car and a test: the engines, the record
 * and the agent. The room passes none of them and gets the real ones.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav } from "./audio.ts";
import { Channel } from "./channel.ts";
import { saveSettings, settingsInForce, type Config } from "./config.ts";
import { Conversation, type MakeAgent } from "./conversation.ts";
import { receiveCrash } from "./crash.ts";
import { Cues } from "./cues.ts";
import type { Event } from "./diagnostics.ts";
import { Ear, SILENCE_MS } from "./ear.ts";
import { Measures } from "./measures.ts";
import type { Outgoing } from "./messages.ts";
import { Mouth, keptLines, type Speaker } from "./mouth.ts";
import { Recorder } from "./record.ts";
import { Screens } from "./screen.ts";
import { SCREENSHOT_DIR, Screenshots } from "./screenshot.ts";
import { LocalWhisper, SpokenAhead, textToSpeech, type SpeechToText, type TextToSpeech } from "./speech.ts";
import { Working, jobsRunning } from "./working.ts";

/** 18 the session's own line, then every event after it, appended as it happens. */
function recorder(config: Config): (event: Event) => void {
  const record = new Recorder(config.recordPath);
  record.session(settingsInForce(config));
  return (event) => record.write(event);
}

export interface Bridge {
  readonly conversation: Conversation;
  readonly ear: Ear;
  readonly mouth: Mouth;
  readonly channel: Channel;
  readonly measures: Measures;
  readonly stt: SpeechToText;
  readonly tts: TextToSpeech;
  /** the engines warmed and the cues built; the room can be joined meanwhile */
  readonly ready: Promise<void>;
  /**
   * 17.17 one line said aloud when the bridge is free, and shown at once. The
   * voice and the words go together: a caller that remembered only one of them
   * left the app silent or the room speaking to nobody.
   */
  announce(text: string): void;
  stop(): void;
}

/**
 * What differs between the car and a test. Each part left out is made here, as
 * the car's own: a whisper that costs seven seconds to warm, a voice that holds
 * a graphics card, a record on disk, and a Claude Code process. A test passes
 * fakes and gets the same wiring around them.
 */
export interface Parts {
  /** 4.8 the recording becomes words */
  stt?: SpeechToText;
  /** 4.8 the sentence becomes sound */
  tts?: TextToSpeech;
  /** 11.6 the sentence made ahead of the one being spoken. It is made from `tts` when it is left out */
  made?: Pick<SpokenAhead, "take" | "start" | "use">;
  /** 15 the cue files, built once */
  cues?: Pick<Cues, "file"> & { build(): Promise<void> };
  /** 18 where every event of the session goes. A test that keeps none passes a sink that drops them */
  record?: (event: Event) => void;
  /** 5.1 the agent behind the turn */
  makeAgent?: MakeAgent;
  /** 14.10 how many detached jobs run, which is work with no turn behind it */
  jobs?: () => number;
  /**
   * 9.4 where a setting said out loud is kept for the next run. The car writes
   * the config file; a test must not, and passing this is how it says so.
   */
  settings?: (patch: Partial<Config>) => void;
  /** where the wavs of this run are written */
  scratch?: string;
  /** 14.12 where the screenshots from the phone are written */
  screenshots?: string;
}

/**
 * `sampleRate` is the rate the frames arrive at. `say` is the journal; the
 * ear, the channel and the turn line all write to it.
 */
export function assemble(
  dir: string,
  config: Config,
  sampleRate: number,
  speaker: Speaker,
  send: (message: Outgoing) => void,
  say: (line: string) => void = console.log,
  parts: Parts = {},
): Bridge {
  const scratch = parts.scratch ?? mkdtempSync(join(tmpdir(), "sidetone-"));
  const speechDir = new URL("../speech", import.meta.url).pathname;
  const stt = parts.stt ?? new LocalWhisper(config, speechDir);
  const tts = parts.tts ?? textToSpeech(config, speechDir);
  const ahead = parts.made ?? new SpokenAhead(tts, scratch, keptLines(config));
  const cues = parts.cues ?? new Cues(scratch, config.cueVolume);
  const ready = Promise.all([stt.start(), tts.start(), cues.build()]).then(() => undefined);

  // 18 the record outlives the process: the scorecard is read after a drive,
  // and a restart in between used to leave nothing to read.
  const write = parts.record ?? recorder(config);
  const keep = parts.settings ?? saveSettings;
  // 18 one bookkeeper: the spoken report and the record are the same facts
  const measures = new Measures(write);
  // 11.3 whether Chris is talking is the ear's word; it stops the frames
  const mouth = new Mouth(speaker, ahead, cues, measures, {
    ...config,
    talking: () => ear.bargingIn,
    // 15.8 the tracks are decoded at the rate the room plays at, so nothing resamples them
    music: { folder: config.holdMusicFolder, gain: config.holdMusicGain, rate: sampleRate, fadeMs: config.holdMusicFadeMs },
    // 14.13 a client lights the words as the voice reaches them
    speaking: (sentence) => channel.tell({ kind: "speaking", text: sentence.text, ...(sentence.answer === undefined ? {} : { answer: sentence.answer }) }),
    say,
  });

  const screens = new Screens();
  // 14.12.7 the client shows what became of each screenshot
  const screenshots = new Screenshots(parts.screenshots ?? SCREENSHOT_DIR, (message) => channel.tell(message));
  const channel: Channel = new Channel(config, send, {
    heard: (text) => conversation.heard(text),
    // ADR 0008 a cut drops the half recording, and the hold with it, or nothing
    // resolves it. An open leaves the recorder alone: an app that re-sends its
    // state on reconnect must not drop a command that is being transcribed.
    // 9.5.2 a release is a hold to talk button let go: the words end now.
    // 15.14 a hold and a release each have a cue. The release cue goes first,
    // so the `heard` that the reset plays comes after it.
    microphone: (on, hold) => {
      if (hold) conversation.cue(on ? "hold" : "release");
      if (!on) ear.reset(hold);
    },
    voice: (on) => mouth.setAudio(on),
    // 15.7.3 the setting the voice command sets; the conversation reads it on every look
    music: (on) => conversation.setMusic(on),
    quality: (side, quality) => conversation.network.saw(side, quality),
    setting: (patch) => conversation.set(patch),
    screen: (part) => screens.receive(part),
    screenshot: (part) => screenshots.receive(part),
    crash: (report) => receiveCrash(report),
  }, say, () => ({ audio: mouth.audioOn }));

  const conversation: Conversation = new Conversation(dir, config, mouth, channel, {
    // 9.4 the file is for the next run; the live copy is what /diagnostics and
    // the health line report now; the record says when it changed
    onSetting: (patch) => {
      Object.assign(config, patch);
      keep(patch);
      measures.setting(patch);
      // 9.4.9 every client sees what is in force now, however it was changed
      channel.settings();
    },
    onTurn: (turn) => say(`[turn ${turn.number}, $${conversation.agent.totalCostUsd().toFixed(4)} this session]`),
    // 11.12 the audio went on or off by voice; the app's own button reads this back
    onAudio: () => channel.settings(),
    // 14.12.6 the pending screenshots join the turn Chris asks for next
    screenshots: () => screenshots.take(),
  }, parts.makeAgent);

  let counter = 0;
  /** 11.5 and 18.4 entire: the listening policy, one module, driven by frames. */
  const ear: Ear = new Ear(conversation.ears, async (utterance) => {
    const wav = join(scratch, `heard-${++counter}.wav`);
    await Bun.write(wav, encodeWav(utterance.samples, sampleRate));
    return stt.transcribe(wav);
  }, { ...config, sampleRate }, measures, say);

  conversation.start();
  const watch = setInterval(() => channel.silence(ear.silence()), SILENCE_MS / 3);
  // 14.10 whether the agent works, said to the client whatever the audio does
  const working = new Working(() => conversation.busy, parts.jobs ?? (() => jobsRunning()), (on) => channel.tell({ kind: "working", on }));
  const work = setInterval(() => {
    working.tick();
    for (const line of screenshots.expire()) channel.journal(line);
  }, 1_000);

  return {
    conversation, ear, mouth, channel, measures, stt, tts, ready,
    announce(text: string) {
      mouth.announce(text, () => !conversation.busy);
      // 17.17 the words reach the app at once, which notifies them when it is not in front
      channel.tell({ kind: "narration", text, announce: true });
    },
    stop() { clearInterval(watch); clearInterval(work); conversation.stop(); stt.stop(); tts.stop(); },
  };
}
