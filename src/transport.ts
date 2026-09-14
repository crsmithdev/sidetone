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

  /**
   * Every frame of every microphone in the room, at 48 kHz. The bridge is the
   * only other participant, and it never subscribes to itself.
   */
  onAudio(handle: (frame: Int16Array) => void): void {
    const started = new Set<string>();
    const pump = (track: RemoteTrack): void => {
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      const sid = track.sid ?? `${started.size}`;
      if (started.has(sid)) return;
      started.add(sid);
      void (async () => {
        const stream = new AudioStream(track, { sampleRate: RTC_RATE, numChannels: 1 });
        for await (const frame of stream) {
          if (this.stopped) return;
          handle(new Int16Array(frame.data.buffer, frame.data.byteOffset, frame.data.length));
        }
      })();
    };
    this.room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => pump(track));
    // A track subscribed before this handler was attached never fires the event
    // again, and the bridge then looks deaf for the life of the room.
    for (const participant of this.room.remoteParticipants.values()) {
      for (const publication of participant.trackPublications.values()) {
        if (publication.track) pump(publication.track as RemoteTrack);
      }
    }
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

  /** 14.8 a client that just arrived has to be given what it missed. */
  onParticipant(handle: (identity: string) => void): void {
    this.room.on(RoomEvent.ParticipantConnected, (participant: RemoteParticipant) => handle(participant.identity ?? ""));
  }

  async send(value: unknown): Promise<void> {
    const payload = new TextEncoder().encode(JSON.stringify(value));
    await this.room.localParticipant?.publishData(payload, { reliable: true });
  }

  /**
   * 5.8 the speech, one sentence at a time. It returns when the audio has been
   * handed over, and stops early when `until` says Chris started talking, which
   * is what makes 11.3 possible now that the framework cancels the echo.
   */
  async speak(wavBytes: Uint8Array, until?: () => boolean): Promise<boolean> {
    const wav = decodeWav(wavBytes);
    const samples = resample(wav.samples, wav.sampleRate, RTC_RATE);
    const size = (RTC_RATE * FRAME_MS) / 1000;
    for (let at = 0; at < samples.length; at += size) {
      if (this.stopped) return false;
      if (until?.()) return false;
      const frame = new AudioFrame(frameAt(samples, at, size), RTC_RATE, 1, size);
      await this.source.captureFrame(frame);
    }
    return true;
  }

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
