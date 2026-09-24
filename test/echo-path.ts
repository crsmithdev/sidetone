/**
 * The room, made of numbers: the bridge's voice, the way it comes back through
 * the phone's microphone, and the frames the ear is handed.
 *
 * On 23 September the phone's canceller let a whole passage back in, and three
 * guards stood between that and a fault: the canceller itself, the barge-in
 * gate and the echo drop. The last two live in this repo, so this is the echo
 * without the car: the audio of a reply, delayed and made quieter, pushed
 * through `Ear.frame` as though the room had made it.
 *
 * The ear and the barge-in gate read levels, not words, and a test scripts its
 * transcriber, so the voice here has the shape of speech and none of its
 * content: one burst per syllable, a gap between words, a longer one after a
 * sentence. It is made in place, with no engine and no GPU.
 */
import { level } from "../src/audio.ts";
import { RATE } from "./harness.ts";

/** The frame LiveKit hands over. */
const FRAME_MS = 20;

/**
 * How the voice is laid out in time. Read speech runs about four syllables a
 * second, and the gaps are what the barge-in gate sees as dips.
 */
const SYLLABLE_MS = 130;
const BETWEEN_SYLLABLES_MS = 40;
const BETWEEN_WORDS_MS = 90;
const AFTER_SENTENCE_MS = 400;

/**
 * The loudest 20 ms frame of a syllable, as the ear measures it. Chris's own
 * peaks in the record run 0.4 to 0.55, and the echo of 23 September peaked at
 * 0.543 before the canceller and the car had anything more to say.
 */
export const VOICE_LEVEL = 0.5;

/** The harmonics of a voiced sound, loudest first; a tone with one would be a beep. */
const HARMONICS = [1, 0.6, 0.4, 0.25, 0.15];

/** What comes back from the room, relative to what went out. */
export interface Path {
  /** how much later the microphone hears it */
  delayMs: number;
  /** how much quieter it is: 1 is the speaker at the microphone */
  gain: number;
  /** a second copy off a wall or a window, later and quieter still */
  room?: { delayMs: number; gain: number };
}

/**
 * What the phone's echo canceller does to the sound, as the car of 23
 * September showed it: it lets the first `leakMs` of each sentence through
 * whole, before it has an estimate to subtract, then holds the rest down to
 * `residual` of its level. A gap of a sentence's length loses the estimate;
 * a gap between words does not.
 */
export interface Canceller {
  leakMs: number;
  residual: number;
}

/** A gap this long is a sentence end, which the canceller has to start over after. */
const LOSES_ESTIMATE_MS = 300;

/** Under this a frame is the room, not the voice, to the canceller. */
const CANCELLER_FLOOR = 0.01;

/** Speech-shaped audio for `text`: the syllables, the words and the sentences, as bursts and gaps. */
export function voice(text: string, rate = RATE): Int16Array {
  const pieces: Int16Array[] = [];
  let syllables = 0;
  for (const sentence of text.split(/(?<=[.!?])\s+/).filter(Boolean)) {
    const words = sentence.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word));
    for (const [index, word] of words.entries()) {
      if (index > 0) pieces.push(quietSamples(BETWEEN_WORDS_MS - BETWEEN_SYLLABLES_MS, rate));
      const count = Math.max(1, (word.toLowerCase().match(/[aeiouy]+/g) ?? []).length);
      for (let i = 0; i < count; i++) {
        // the pitch moves a little from one syllable to the next, as a voice does
        pieces.push(syllable(120 + (syllables++ * 7) % 40, rate));
        pieces.push(quietSamples(BETWEEN_SYLLABLES_MS, rate));
      }
    }
    pieces.push(quietSamples(AFTER_SENTENCE_MS, rate));
  }
  return concat(pieces);
}

/** One burst of voiced sound, with a raised-cosine envelope so it has an onset and a fall. */
function syllable(pitchHz: number, rate: number): Int16Array {
  const length = Math.round((SYLLABLE_MS * rate) / 1000);
  const out = new Int16Array(length);
  // the level of the harmonics together, so the frame at the envelope's peak reads VOICE_LEVEL
  const rms = Math.sqrt(HARMONICS.reduce((sum, a) => sum + (a * a) / 2, 0));
  const scale = (VOICE_LEVEL / rms) * 32767;
  for (let i = 0; i < length; i++) {
    const t = i / rate;
    const envelope = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / length);
    let sample = 0;
    for (const [k, amplitude] of HARMONICS.entries()) sample += amplitude * Math.sin(2 * Math.PI * pitchHz * (k + 1) * t);
    out[i] = clip(sample * envelope * scale);
  }
  return out;
}

/** The voice as the microphone hears it: later, quieter, and with a room's second copy if one is given. */
export function echo(samples: Int16Array, path: Path, rate = RATE): Int16Array {
  const copies = [{ delayMs: path.delayMs, gain: path.gain }, ...(path.room ? [path.room] : [])];
  const longest = Math.max(...copies.map((copy) => copy.delayMs));
  const out = new Int16Array(samples.length + Math.round((longest * rate) / 1000));
  for (const copy of copies) {
    const from = Math.round((copy.delayMs * rate) / 1000);
    for (let i = 0; i < samples.length; i++) out[from + i] = clip(out[from + i]! + samples[i]! * copy.gain);
  }
  return out;
}

/** The sound after the phone's canceller, frame by frame. */
export function cancelled(samples: Int16Array, canceller: Canceller, rate = RATE): Int16Array {
  const out = new Int16Array(samples.length);
  const size = Math.round((FRAME_MS * rate) / 1000);
  let quietMs = Infinity;
  let sinceOnsetMs = Infinity;
  for (let at = 0; at < samples.length; at += size) {
    const block = samples.subarray(at, at + size);
    if (level(block) < CANCELLER_FLOOR) quietMs += FRAME_MS;
    else {
      if (quietMs >= LOSES_ESTIMATE_MS) sinceOnsetMs = 0;
      quietMs = 0;
    }
    const gain = sinceOnsetMs < canceller.leakMs ? 1 : canceller.residual;
    sinceOnsetMs += FRAME_MS;
    for (let i = 0; i < block.length; i++) out[at + i] = clip(block[i]! * gain);
  }
  return out;
}

/** Two sounds in the same room at once: Chris over the voice. */
export function mix(...tracks: Int16Array[]): Int16Array {
  const out = new Int16Array(Math.max(...tracks.map((track) => track.length)));
  for (const track of tracks) for (let i = 0; i < track.length; i++) out[i] = clip(out[i]! + track[i]!);
  return out;
}

/** The sound as the phone sends it: 20 ms frames, the last one padded. */
export function frames(samples: Int16Array, rate = RATE): Int16Array[] {
  const size = Math.round((FRAME_MS * rate) / 1000);
  const out: Int16Array[] = [];
  for (let at = 0; at < samples.length; at += size) {
    const frame = new Int16Array(size);
    frame.set(samples.subarray(at, at + size));
    out.push(frame);
  }
  return out;
}

/** The room after the sound: frames at the level of a quiet car, which is what ends an utterance. */
export function quiet(ms: number, rate = RATE): Int16Array[] {
  return frames(quietSamples(ms, rate, 0.001), rate);
}

/**
 * The sound reaches the ear, then the quiet that ends the utterance. The
 * frames go in as fast as the loop runs, so the ear's clocks see the whole
 * utterance arrive at once, as they do when a test drives it.
 */
export function hear(ear: { frame(frame: Int16Array): void }, samples: Int16Array, pauseMs = 1_600, rate = RATE): void {
  for (const frame of [...frames(samples, rate), ...quiet(pauseMs, rate)]) ear.frame(frame);
}

/** The loudest 20 ms frame, as the ear measures a peak. */
export function peakLevel(samples: Int16Array, rate = RATE): number {
  return Math.max(0, ...frames(samples, rate).map(level));
}

function quietSamples(ms: number, rate: number, at = 0): Int16Array {
  const out = new Int16Array(Math.round((ms * rate) / 1000));
  if (at) out.fill(Math.round(at * 32768));
  return out;
}

function clip(sample: number): number {
  return Math.max(-32768, Math.min(32767, Math.round(sample)));
}

function concat(blocks: Int16Array[]): Int16Array {
  let total = 0;
  for (const block of blocks) total += block.length;
  const out = new Int16Array(total);
  let at = 0;
  for (const block of blocks) { out.set(block, at); at += block.length; }
  return out;
}
