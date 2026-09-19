/**
 * The bridge, assembled: the engines, the mouth, the conversation, the ear and
 * the control channel, joined once.
 *
 * The room and the desk each built this by hand, in the same order, and the
 * copies drifted: the desk built a bookkeeper with no record behind it, and
 * three commits in a week touched both. There is one caller now, the room,
 * and one hand-built copy in the tests; either supplies the two ends that
 * differ, a `Speaker` that plays one sentence and a sink that reaches the
 * client, and takes the rest joined.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav } from "./audio.ts";
import { Channel } from "./channel.ts";
import { saveSettings, settingsInForce, type Config } from "./config.ts";
import { Conversation } from "./conversation.ts";
import { Cues } from "./cues.ts";
import { Ear, SILENCE_MS } from "./ear.ts";
import { Measures } from "./measures.ts";
import type { Outgoing } from "./messages.ts";
import { Mouth, keptLines, type Speaker } from "./mouth.ts";
import { Recorder } from "./record.ts";
import { LocalWhisper, SpokenAhead, textToSpeech, type TextToSpeech } from "./speech.ts";

export interface Bridge {
  readonly conversation: Conversation;
  readonly ear: Ear;
  readonly mouth: Mouth;
  readonly channel: Channel;
  readonly measures: Measures;
  readonly stt: LocalWhisper;
  readonly tts: TextToSpeech;
  /** the engines warmed and the cues built; the room can be joined meanwhile */
  readonly ready: Promise<void>;
  stop(): void;
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
): Bridge {
  const scratch = mkdtempSync(join(tmpdir(), "voice-bridge-"));
  const speechDir = new URL("../speech", import.meta.url).pathname;
  const stt = new LocalWhisper(config, speechDir);
  const tts = textToSpeech(config, speechDir);
  const ahead = new SpokenAhead(tts, scratch, keptLines(config));
  const cues = new Cues(scratch, config.cueVolume);
  const ready = Promise.all([stt.start(), tts.start(), cues.build()]).then(() => undefined);

  // 18 the record outlives the process: the scorecard is read after a drive,
  // and a restart in between used to leave nothing to read.
  const record = new Recorder(config.recordPath);
  record.session(settingsInForce(config));
  // 18 one bookkeeper: the spoken report and the record are the same facts
  const measures = new Measures((event) => record.write(event));
  // 11.3 whether Chris is talking is the ear's word; it stops the frames
  const mouth = new Mouth(speaker, ahead, cues, measures, { ...config, talking: () => ear.bargingIn });

  const channel: Channel = new Channel(config, send, {
    heard: (text) => conversation.heard(text),
    // the hold goes with the half recording, or nothing resolves it
    microphone: () => ear.reset(),
    voice: (on) => mouth.setVoice(on),
    quality: (side, quality) => conversation.network.saw(side, quality),
  }, say);

  const conversation: Conversation = new Conversation(dir, config, mouth, channel, {
    // 9.4 the file is for the next run; the live copy is what /diagnostics and
    // the health line report now; the record says when it changed
    onSetting: (patch) => { Object.assign(config, patch); saveSettings(patch); measures.setting(patch); },
    onTurn: (turn) => say(`[turn ${turn.number}, $${conversation.agent.totalCostUsd().toFixed(4)} this session]`),
  });

  let counter = 0;
  /** 11.5 and 18.4 entire: the listening policy, one module, driven by frames. */
  const ear: Ear = new Ear(conversation.ears, async (utterance) => {
    const wav = join(scratch, `heard-${++counter}.wav`);
    await Bun.write(wav, encodeWav(utterance.samples, sampleRate));
    return stt.transcribe(wav);
  }, { ...config, sampleRate }, measures, say);

  conversation.start();
  const watch = setInterval(() => channel.silence(ear.silence()), SILENCE_MS / 3);

  return {
    conversation, ear, mouth, channel, measures, stt, tts, ready,
    stop() { clearInterval(watch); conversation.stop(); stt.stop(); tts.stop(); },
  };
}
