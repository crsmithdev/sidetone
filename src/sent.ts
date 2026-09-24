/**
 * The clips the bridge sent, kept so the agent can hear its own voice (spec
 * 18.14).
 *
 * The agent cannot hear what it says. On 23 September Chris reported three
 * kinds of garbled speech, and the record could not settle any of them: it
 * holds the text and the timings, not the sound. So the bridge keeps a copy of
 * each clip it hands to the room, and `scripts/sent-check.ts` transcribes a
 * copy and compares the words with the text it was made from.
 *
 * A clean copy does not clear the whole path. The copy is taken in the bridge,
 * so a fault that starts in the network, the room or the phone's decoder does
 * not show in it.
 */
import { copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { decodeWav } from "./audio.ts";
import { likeness } from "./echo.ts";
import type { SpeechToText } from "./speech.ts";

/**
 * 18.14.1 how many clips are kept. A sentence of the cloning voice is two to
 * five seconds, about 100 to 250 kB at 24 kHz, so this is about 20 MB of disk.
 * An answer is 5 to 20 sentences, so this holds the last five or more answers:
 * enough that a report Chris makes a few minutes later still finds the clip.
 */
export const SENT_KEPT = 100;

/** Where a clip came from: a kept line played from disk (11.6), or made by the engine for this sentence. */
export type Source = "kept" | "made";

export interface SentClip {
  id: string;
  wav: string;
  text: string;
  at: number;
  source: Source;
}

/** 18.14.1 the last `limit` clips the bridge sent, on disk, the oldest deleted first. */
export class SentClips {
  private counter = 0;

  constructor(private readonly dir: string, private readonly limit = SENT_KEPT) {}

  /**
   * Copy the wav, and write its text beside it. The copy is synchronous: the
   * wav may be a scratch file that the next sentence deletes.
   */
  keep(wav: string, text: string, source: Source, at = Date.now()): void {
    mkdirSync(this.dir, { recursive: true });
    // the time orders the clips; the counter orders two in the same millisecond
    const id = `${at}-${String(++this.counter).padStart(6, "0")}`;
    copyFileSync(wav, join(this.dir, `${id}.wav`));
    writeFileSync(join(this.dir, `${id}.json`), JSON.stringify({ text, at, source }));
    for (const old of this.list().slice(this.limit)) {
      rmSync(old.wav, { force: true });
      rmSync(join(this.dir, `${old.id}.json`), { force: true });
    }
  }

  /** The clips on disk, newest first. */
  list(): SentClip[] {
    let names: string[];
    try { names = readdirSync(this.dir); } catch { return []; }
    const clips: SentClip[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      try {
        const { text, at, source } = JSON.parse(readFileSync(join(this.dir, name), "utf8")) as Omit<SentClip, "id" | "wav">;
        clips.push({ id, wav: join(this.dir, `${id}.wav`), text, at, source });
      } catch { /* a text half written by a process that died: its wav goes with the limit */ }
    }
    return clips.sort((a, b) => b.at - a.at || (b.id < a.id ? -1 : 1));
  }
}

/**
 * 18.14.2 below this the transcription and the text differ too much for the
 * clip to be clean. Whisper writes the bridge's own voice back almost word for
 * word, so a fifth of the letters lost, added or moved is more than
 * punctuation or a number spelled out.
 */
const CLEAN = 0.8;

export interface ClipCheck {
  ms: number;
  sampleRate: number;
  channels: number;
  /** loudest sample, as a fraction of full scale */
  peak: number;
  /** the lesser of the two likenesses, text in heard and heard in text */
  likeness: number;
  garbled: boolean;
}

/**
 * 18.14.2 check a sent clip against the text it was made from. `heard` is what
 * the speech worker wrote for the clip.
 *
 * `likeness` asks how much of its first argument is in the second, so it is
 * asked both ways. Heard in the text finds a repeat or an added sound; the
 * text in heard finds a lost one.
 */
export function checkClip(bytes: Uint8Array, text: string, heard: string): ClipCheck {
  const wav = decodeWav(bytes);
  let loudest = 0;
  for (const sample of wav.samples) loudest = Math.max(loudest, Math.abs(sample));
  const alike = Math.min(likeness(heard, text), likeness(text, heard));
  return {
    ms: Math.round(wav.samples.length / wav.channels / wav.sampleRate * 1000),
    sampleRate: wav.sampleRate,
    channels: wav.channels,
    peak: loudest / 32768,
    likeness: alike,
    garbled: alike < CLEAN,
  };
}

/**
 * 11.6.1 the check a kept line passes before it is kept: the speech worker
 * transcribes it, and the words must match its text.
 */
export function clipChecker(stt: Pick<SpeechToText, "transcribe">): (wav: string, text: string) => Promise<boolean> {
  return async (wav, text) => !checkClip(await Bun.file(wav).bytes(), text, await stt.transcribe(wav)).garbled;
}
