/**
 * LiveKit over WebRTC (spec 4.1). The transport is not built by hand and it is
 * not a plain websocket: WebRTC is what survives an open microphone during
 * playback, a barge-in, and a connection that drops and moves between towers
 * in a car (14.1).
 *
 * 4.2 says the echo cancellation comes from the framework, at the client. The
 * bridge therefore never has to guess whether it is hearing itself, which is
 * what the desk loop of 7.3 had to do.
 *
 * 4.3 keeps control off the audio path: the transcript, the turn numbers and
 * the state go over data messages, which do not compete with audio frames.
 */
import {
  AudioFrame, AudioSource, AudioStream, LocalAudioTrack, Room, RoomEvent,
  TrackKind, TrackPublishOptions, TrackSource, type RemoteParticipant, type RemoteTrack,
} from "@livekit/rtc-node";
import { randomUUID } from "node:crypto";
import { AccessToken } from "livekit-server-sdk";
import { decodeWav } from "./audio.ts";
import type { Fade, Speaker } from "./mouth.ts";

/**
 * One per process, so a restart never collides with the session it replaces.
 * The clock alone is not enough: two of these inside a millisecond collided
 * fourteen times in two hundred, and a collision here is the whole bug.
 */
export function uniqueIdentity(prefix = "bridge"): string {
  return `${prefix}-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

/** WebRTC carries 48 kHz mono; everything is resampled to it before it is sent. */
export const RTC_RATE = 48_000;
const FRAME_MS = 20;

export interface Keys {
  url: string;
  apiKey: string;
  apiSecret: string;
}

/** 12.2 the client pairs once and keeps a long-lived token. */
export async function tokenFor(keys: Keys, room: string, identity: string, hours: number): Promise<string> {
  const token = new AccessToken(keys.apiKey, keys.apiSecret, { identity, ttl: `${hours}h` });
  token.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
  return token.toJwt();
}

/** Nearest-neighbour is enough between 22 and 48 kHz for speech, and costs nothing. */
export function resample(samples: Int16Array, from: number, to: number): Int16Array {
  if (from === to) return samples;
  const out = new Int16Array(Math.round((samples.length * to) / from));
  for (let i = 0; i < out.length; i++) out[i] = samples[Math.min(samples.length - 1, Math.floor((i * from) / to))] as number;
  return out;
}

/** What the bridge needs from a room, with the SDK kept behind it. */
export class Transport {
  readonly room = new Room();
  private source = new AudioSource(RTC_RATE, 1);
  private stopped = false;
  /** 14.8 what to do with a client that arrives, kept for the ones already there at connect */
  private arrived?: (identity: string) => void;

  /**
   * Join with a token, the way a client does. A client never holds the api
   * secret, so this is the path that does not mint its own (12.2).
   *
   * The published track is this transport's own source, which is what speak()
   * writes to. Publishing a source of your own and then calling speak() is
   * silence, and it looks exactly like a bridge that cannot hear.
   */
  async connect(url: string, token: string, name = "bridge"): Promise<void> {
    await this.room.connect(url, token, { autoSubscribe: true, dynacast: false });
    // 14.15 a restart of the bridge leaves the phone in its room, and the SDK
    // names no arrival for a participant that was there first
    for (const participant of this.room.remoteParticipants.values()) this.arrived?.(participant.identity ?? "");
    const track = LocalAudioTrack.createAudioTrack(name, this.source);
    const options = new TrackPublishOptions();
    options.source = TrackSource.SOURCE_MICROPHONE;
    await this.room.localParticipant?.publishTrack(track, options);
  }

  /**
   * Join as the bridge, which does hold the keys.
   *
   * The identity has to be different every time. LiveKit allows one
   * participant per identity in a room, and a restart arrives while the old
   * session is still registered: the server logs DUPLICATE_IDENTITY, closes a
   * participant, and the new process is left holding a room it is not in.
   * Nothing errors. `connect()` resolves, one quality event arrives, and then
   * it is simply out. Every restart did this, which is why the bridge had to
   * run for three days untouched to look reliable.
   */
  async join(keys: Keys, roomName: string, identity = uniqueIdentity()): Promise<void> {
    await this.connect(keys.url, await tokenFor(keys, roomName, identity, 24), identity);
  }

  /** The frames of one track, at 48 kHz. A test gives its own. */
  private stream = (track: RemoteTrack): AsyncIterable<{ data: Int16Array }> =>
    new AudioStream(track, { sampleRate: RTC_RATE, numChannels: 1 });

  /**
   * Every frame of every microphone in the room, at 48 kHz. The bridge is the
   * only other participant, and it never subscribes to itself.
   *
   * 18.9.7 one track per participant feeds the ear: the newest. On 23
   * September a track outlived the app's cut, and each later press published
   * a second one. The dead track's silent frames went into the same ear, and
   * every press gave a barge-in and no utterance. An older track stays
   * subscribed and its frames are dropped, so it feeds the ear again when the
   * newer one goes.
   */
  onAudio(handle: (frame: Int16Array) => void, say: (line: string) => void = console.log): void {
    const started = new Set<string>();
    /** the audio tracks of each participant, oldest first */
    const tracks = new Map<string, string[]>();
    const add = (identity: string, sid: string): void => {
      const sids = tracks.get(identity) ?? [];
      const older = sids.at(-1);
      sids.push(sid);
      tracks.set(identity, sids);
      if (older) say(`[a newer microphone track from ${identity}: ${sid} feeds the ear, ${older} no longer does]`);
    };
    const remove = (identity: string, sid: string): void => {
      const sids = tracks.get(identity) ?? [];
      const at = sids.indexOf(sid);
      if (at < 0) return;
      sids.splice(at, 1);
      if (at === sids.length && sids.length) say(`[${sids.at(-1)} from ${identity} feeds the ear again]`);
    };
    const pump = (track: RemoteTrack, identity: string): void => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      const sid = track.sid ?? `${started.size}`;
      if (started.has(sid)) return;
      started.add(sid);
      add(identity, sid);
      void (async () => {
        for await (const frame of this.stream(track)) {
          if (this.stopped) return;
          if (tracks.get(identity)?.at(-1) !== sid) continue;
          handle(new Int16Array(frame.data.buffer, frame.data.byteOffset, frame.data.length));
        }
      })();
    };
    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack, _: unknown, participant: RemoteParticipant) => pump(track, participant.identity ?? ""));
    // A resubscribe gives the same track back, and a sid left in the set would
    // then refuse to pump it: the bridge would hold a live microphone it never
    // reads. Nothing in the room says so, which is how a deaf bridge hides.
    this.room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, _: unknown, participant: RemoteParticipant) => {
      if (!track.sid) return;
      started.delete(track.sid);
      remove(participant.identity ?? "", track.sid);
    });
    // A track subscribed before this handler was attached never fires the event
    // again, and the bridge then looks deaf for the life of the room.
    for (const participant of this.room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.track) pump(publication.track as RemoteTrack, participant.identity ?? "");
      }
    }
  }

  /**
   * 18 whether there is a microphone in the room at all.
   *
   * On 18 September the phone cut its microphone and reopened it, and the
   * bridge heard nothing for the next twenty minutes without one line in the
   * journal about it. Whether a track arrived is the first thing to know and
   * the bridge was not saying it.
   */
  onMicrophone(handle: (on: boolean, sid: string) => void): void {
    const say = (on: boolean) => (track: RemoteTrack) => {
      if (track.kind === TrackKind.KIND_AUDIO) handle(on, track.sid ?? "");
    };
    this.room.on(RoomEvent.TrackSubscribed, say(true));
    this.room.on(RoomEvent.TrackUnsubscribed, say(false));
  }

  /** 4.3 the control channel: the transcript and the state, not the audio. */
  onMessage(handle: (value: Record<string, unknown>, from: string) => void): void {
    this.room.on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant) => {
      try { handle(JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>, participant?.identity ?? ""); }
      catch { /* a client that sends nonsense is not a reason to stop */ }
    });
  }

  /**
   * N.1 the framework's own reading of the connection, per participant. The
   * bridge measures nothing here: WebRTC keeps the round trip, the loss and
   * the jitter, and LiveKit reduces them to four levels.
   */
  onQuality(handle: (quality: unknown, identity: string) => void): void {
    this.room.on(RoomEvent.ConnectionQualityChanged, (quality: unknown, participant?: { identity?: string }) => {
      handle(quality, participant?.identity ?? "");
    });
  }

  /**
   * 14.8 a client that just arrived has to be given what it missed. Call it
   * before the join: a client already in the room is told of once, at connect.
   */
  onParticipant(handle: (identity: string) => void): void {
    this.arrived = handle;
    this.room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => handle(participant.identity ?? ""));
  }

  async send(value: unknown): Promise<void> {
    await this.publish(new TextEncoder().encode(JSON.stringify(value)));
  }

  /** 14.11 the bytes of one data message. `Outbound` decides what goes in them. */
  async publish(payload: Uint8Array): Promise<void> {
    await this.room.localParticipant?.publishData(payload, { reliable: true });
  }

  /**
   * 5.8 the speech, one sentence at a time. It returns when the audio has been
   * handed over, and stops early when `until` says Chris started talking, which
   * is what makes 11.3 possible now that the framework cancels the echo.
   */
  async speak(wavBytes: Uint8Array, until?: () => boolean, fade?: Fade): Promise<boolean> {
    // One source takes one writer. A cue that began while a sentence was still
    // playing used to interleave frames and the transport threw
    // `InvalidState - failed to capture frame`. The callers guard against it,
    // but they guard synchronously and then read a file, so the guard could be
    // true when it was checked and false by the time the frames arrived.
    const mine = this.writing.then(() => this.write(wavBytes, until, fade), () => this.write(wavBytes, until, fade));
    this.writing = mine.then(() => undefined, () => undefined);
    return mine;
  }

  /** Whether frames are going out right now, so a cue can be dropped rather than queued behind a sentence. */
  get speaking(): boolean { return this.writers > 0; }

  private async write(wavBytes: Uint8Array, until?: () => boolean, fade?: Fade): Promise<boolean> {
    this.writers++;
    try { return await this.frames(wavBytes, until, fade); }
    finally { this.writers--; }
  }

  private async frames(wavBytes: Uint8Array, until?: () => boolean, fade?: Fade): Promise<boolean> {
    const wav = decodeWav(wavBytes);
    const samples = resample(wav.samples, wav.sampleRate, RTC_RATE);
    const size = (RTC_RATE * FRAME_MS) / 1000;
    // the sample at which the fade began, once it has
    let fadedAt = -1;
    for (let at = 0; at < samples.length; at += size) {
      if (this.stopped) return false;
      if (until?.()) {
        // 11.3 and 11.12.2 the source takes a second of frames ahead of what it
        // has sent, so a loop that only stops writing leaves a second of voice
        // to play out: the end of a short sentence. The frames it holds go too.
        this.source.clearQueue();
        return false;
      }
      const data = frameAt(samples, at, size);
      if (fade) {
        if (fadedAt < 0 && fade.when()) fadedAt = at;
        if (fadedAt >= 0) {
          const length = (RTC_RATE * fade.ms) / 1000;
          if (at - fadedAt >= length) return false;
          fadeOut(data, at - fadedAt, length);
        }
      }
      await this.source.captureFrame(new AudioFrame(data, RTC_RATE, 1, size));
    }
    return true;
  }

  private writing: Promise<void> = Promise.resolve();
  private writers = 0;

  /** Whether the room is joined right now, for the health check. */
  get connected(): boolean { return this.room.isConnected; }

  /** Whether an identity in the room is this bridge, whatever it called itself. */
  isSelf(identity: string): boolean {
    return identity === this.room.localParticipant?.identity;
  }

  /**
   * 14.1 the transport is meant to survive a link that comes and goes, but at
   * startup there is nothing to survive yet: if livekit is not listening the
   * join throws and the process exits. On a boot that is a race, not a fault --
   * the unit is ordered after docker, and docker being up does not mean the
   * container inside it is. So retry, and fail only when it is really not
   * coming.
   */
  async joinWhenReady(keys: Keys, roomName: string, deadlineMs: number, say: (text: string) => void): Promise<void> {
    const until = Date.now() + deadlineMs;
    const identity = uniqueIdentity();
    for (let wait = 500; ; wait = Math.min(wait * 2, 5_000)) {
      try {
        await this.join(keys, roomName, identity);
        return;
      } catch (error) {
        if (Date.now() + wait >= until) throw error;
        say(`waiting for livekit at ${keys.url}: ${(error as Error).message}`);
        await Bun.sleep(wait);
      }
    }
  }

  async close(): Promise<void> {
    this.stopped = true;
    await this.room.disconnect();
  }
}

/** What the room's speaker needs of the transport: one sentence's frames, and whether any are going out. */
export interface Player {
  speak(wavBytes: Uint8Array, until?: () => boolean, fade?: Fade): Promise<boolean>;
  readonly speaking: boolean;
}

/**
 * 7.4 the room's Speaker: it plays over LiveKit and stops the moment Chris
 * talks (11.3). The frames cannot hold the bridge's own voice, because the
 * client cancelled it before sending.
 *
 * It was a literal in `serve()`, next to nothing that tested it, and it read
 * the ear directly. It reads nothing now: the mouth hands it `cut`.
 */
export function roomSpeaker(player: Player, say: (line: string) => void = console.log): Speaker {
  return {
    async play(text, wav, cut) {
      say(`  ${text}`);
      if (!wav) return true;
      const whole = await player.speak(await Bun.file(wav).bytes(), cut);
      if (!whole) say("  [stopped: Chris started talking]");
      return whole;
    },
    cue(wav, cut) {
      void Bun.file(wav).bytes()
        // The mouth checked that nothing was speaking before this read began.
        // If that changed while the file was read, the cue is late: a cue means
        // "still working", and behind a whole answer it means nothing.
        .then((bytes) => (player.speaking ? false : player.speak(bytes, cut)))
        .catch((error) => say(`[the cue failed: ${(error as Error).message}]`));
    },
    track(wav, cut, fade) {
      // one source takes one writer: a cue or a track from /play is on it now
      if (player.speaking) return null;
      say("[hold music]");
      return player.speak(wav, cut, fade).then(
        (whole) => { say(whole ? "[hold music ended]" : "[hold music stopped]"); return whole; },
        (error) => { say(`[hold music failed: ${(error as Error).message}]`); return false; },
      );
    },
  };
}

/**
 * 15.10.2 the frame at `done` samples into a fade of `length` samples, scaled
 * in place. The level falls in a straight line from 1 to 0, so a frame that
 * starts the fade is nearly whole and the one that ends it is nearly silent.
 */
export function fadeOut(frame: Int16Array, done: number, length: number): void {
  for (let i = 0; i < frame.length; i++) frame[i] = Math.round(frame[i]! * Math.max(0, 1 - (done + i) / length));
}

/**
 * One whole frame, copied. The copy is not a nicety: AudioFrame reads the
 * underlying buffer without the view's offset, so handing it a subarray sends
 * the start of the sentence over and over. A piper file opens quietly, so the
 * fault arrives as silence rather than as a stutter, which is worse to find.
 * The last frame is short and the rest of it is silence.
 */
export function frameAt(samples: Int16Array, at: number, size: number): Int16Array {
  const out = new Int16Array(size);
  out.set(samples.subarray(at, Math.min(at + size, samples.length)));
  return out;
}
