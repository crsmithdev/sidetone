/**
 * What the bridge answers over HTTP (spec 7.4, 12), as a plain function of a
 * request, so a test reaches every route without `Bun.serve` and without a
 * room. `serve.ts` joins the room and hands the requests here.
 *
 * The routes decide nothing about sound. /say is `Bridge.announce` and /play
 * is `Mouth.play`: the mouth is the one owner of the audio source.
 */
import { wavFromFile } from "./audio.ts";
import type { Bridge } from "./bridge.ts";
import { settingsInForce, type Config } from "./config.ts";
import { RTC_RATE } from "./transport.ts";

/**
 * How long an engine may take to warm before a health probe calls it a fault.
 * The recover timer probes every 120 seconds, so anything under the real load
 * time makes the bridge restart itself forever.
 *
 * Chatterbox took 146 seconds to load on a quiet machine on 23 September 2026
 * and 240 on a busy one, so the spread matters more than the figure. Ten
 * minutes is deliberately far above both: a bridge that restarts itself
 * forever is unusable, and a stuck engine that waits ten minutes instead of
 * five is a bridge Chris is already listening to and can hear is silent.
 */
const WARMUP_MS = 10 * 60_000;

/**
 * Whether the bridge is well enough to leave alone. The recover timer restarts
 * it when this says no, so it has to say yes while an engine is still loading
 * and no when one never loads. Before 23 September 2026 the port did not open
 * until the engines were warm, so the probe could not ask at all, and the
 * bridge restarted itself every two minutes forever.
 */
export function wellEnough(connected: boolean, running: boolean, warm: boolean, upMs: number): boolean {
  return connected && running && (warm || upMs < WARMUP_MS);
}

/** What pairing gives a client: a token, and the room it lets the client into (12.2). */
export interface Pass {
  token: string;
  url: string;
  room: string;
}

/**
 * 12.1 the boundary (ADR 0005). Three words drawn from twenty-six is 17,576
 * codes, and until 15 September a wrong one cost nothing but the round trip.
 * The port is open to the tailnet for the phone, and a token is thirty days of
 * joining the room, hearing everything and driving the agent.
 *
 * Each wrong code now makes the next one slower, to ten seconds, which turns
 * the whole space into weeks. It does not stop a caller guessing down many
 * connections at once: the answer to that is a longer code, not a longer
 * wait, and the code is read out loud so it stays three words for now.
 */
export class Pairing {
  private wrongCodes = 0;

  constructor(
    readonly code: string,
    private readonly issue: () => Promise<Pass>,
    private readonly sleep: (ms: number) => Promise<void> = Bun.sleep,
  ) {}

  /** The pass for the right code; null, after the wait, for a wrong one. */
  async pair(given: string | undefined): Promise<Pass | null> {
    if (given?.trim().toLowerCase() !== this.code) {
      this.wrongCodes++;
      await this.sleep(Math.min(this.wrongCodes, 20) * 500);
      return null;
    }
    this.wrongCodes = 0;
    return this.issue();
  }
}

/** What the routes read, apart from the request. */
export interface Site {
  config: Config;
  bridge: Bridge;
  pairing: Pairing;
  /** the page in `client/`, read once */
  page: string;
  /** the files served as they are: the LiveKit SDK, the page's decoder, and 17 the Android app */
  files: { sdk: string; decoder: string; apk: string };
  /** whether the room is joined, and whether each engine is warm */
  health: () => { room: boolean; speech: boolean; transcription: boolean };
  startedAt: number;
}

/** The request handler. `ip` is the caller's address, which the local-only routes check. */
export function routes(site: Site): (request: Request, ip: string | undefined) => Promise<Response> {
  const { config, bridge, pairing, files } = site;
  const { conversation, measures, mouth } = bridge;
  return async (request, ip) => {
    const url = new URL(request.url);
    if (url.pathname === "/") return new Response(site.page, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname === "/livekit-client.mjs") return new Response(Bun.file(files.sdk), { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/decode.js") return new Response(Bun.file(files.decoder), { headers: { "content-type": "text/javascript" } });
    if (url.pathname === "/sidetone.apk") {
      if (!(await Bun.file(files.apk).exists())) return new Response("not built", { status: 404 });
      return new Response(Bun.file(files.apk), { headers: { "content-type": "application/vnd.android.package-archive", "content-disposition": 'attachment; filename="sidetone.apk"' } });
    }
    /**
     * Everything measured lately, for reading a session back afterwards.
     *
     * 12.1 this one carries the transcript: every word said and every word
     * answered. It is served to this machine only. The port is open to the
     * tailnet for the phone, and until 15 September anyone who could reach
     * it could read the conversation without the pairing code.
     */
    if (url.pathname === "/diagnostics") {
      if (!isLocal(ip)) return new Response("not found", { status: 404 });
      return Response.json({
        summary: measures.summary(),
        settings: settingsInForce(config),
        latency: measures.rounds(),
        network: { phone: conversation.network.get("phone"), bridge: conversation.network.get("bridge") },
        recent: measures.recent(count(url.searchParams.get("n"), 40)),
      });
    }
    /**
     * Whether this is working, not whether it is running. Restart=always
     * cannot tell the difference: a process that holds a dead room, or has
     * lost the agent, looks exactly like a healthy one from outside. On
     * 13 September 2026 a crash loop went unnoticed for an hour because
     * nothing ever asked.
     */
    if (url.pathname === "/health") {
      const { room, speech, transcription } = site.health();
      const warm = speech && transcription;
      const upMs = Date.now() - site.startedAt;
      const well = wellEnough(room, conversation.agent.running, warm, upMs);
      return Response.json({
        ok: well,
        room: room ? "connected" : "gone",
        agent: conversation.agent.running ? "running" : "stopped",
        engines: { speech, transcription },
        warming: !warm && upMs < WARMUP_MS,
        // 11.12 the one state that makes a working bridge look dead. It cost
        // two journal digs on 21 September, both times an accidental tap.
        audio: mouth.audioOn ? "on" : "off",
        muted: conversation.isMuted,
        network: { phone: conversation.network.get("phone"), bridge: conversation.network.get("bridge") },
        turns: conversation.agent.turns,
        upSeconds: Math.round(upMs / 1000),
      }, { status: well ? 200 : 503 });
    }
    /**
     * 15.12 play a file to the room. It is for a shell on this machine, so
     * the tailnet cannot reach it. The mouth owns the room's one source: the
     * track waits until nothing is being said, then plays, and a sentence
     * fades it out rather than refusing it. It plays nothing, and stops,
     * while the audio is off (11.12).
     */
    if (url.pathname === "/play" && request.method === "POST") {
      if (!isLocal(ip)) return new Response("not found", { status: 404 });
      const body = await request.json().catch(() => ({})) as { file?: string };
      const file = body.file ?? "";
      // ffmpeg reads urls too; an absolute path is the one thing this takes
      if (!file.startsWith("/") || !(await Bun.file(file).exists())) {
        return Response.json({ error: "file must be the absolute path of a file that exists" }, { status: 400 });
      }
      let wav: Uint8Array;
      try { wav = await wavFromFile(file, RTC_RATE); }
      catch (error) { return Response.json({ error: (error as Error).message }, { status: 500 }); }
      if (!mouth.audioOn) return Response.json({ error: "the audio is off" }, { status: 409 });
      // 15.12 the mouth owns the room's one source: the track waits for a
      // sentence rather than being cut off by it, which is what made playing
      // a file and saying a word about it in the same turn impossible.
      console.log(`[playing ${file} when the mouth is free]`);
      mouth.play(wav, config.holdMusicFadeMs);
      return Response.json({ playing: file }, { status: 202 });
    }
    /**
     * Say one line when the bridge is free: `scripts/job` tells Chris here
     * that a detached job ended. The same guard as /play: a shell on this
     * machine only.
     */
    if (url.pathname === "/say" && request.method === "POST") {
      if (!isLocal(ip)) return new Response("not found", { status: 404 });
      const body = await request.json().catch(() => ({})) as { text?: string };
      const text = body.text?.trim() ?? "";
      if (!text) return Response.json({ error: "text must be a line to say" }, { status: 400 });
      console.log(`[to say when free: ${text}]`);
      bridge.announce(text);
      return Response.json({ queued: text }, { status: 202 });
    }
    // 12.1 the boundary. Everything below here needs the code or a token.
    if (url.pathname === "/pair" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { code?: string };
      const pass = await pairing.pair(body.code);
      if (!pass) return Response.json({ error: "that code is not right" }, { status: 403 });
      // 12.3 the same answer serves the web client and the Android app. The url
      // is the one the phone can reach, never the loopback the bridge dials.
      return Response.json(pass);
    }
    return new Response("not found", { status: 404 });
  };
}

/** A window size from the query, or the default: `?n=abc` used to mean the whole buffer. */
function count(value: string | null, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

/** Loopback, in either family. Bun writes an IPv4 client on a dual-stack listener as ::ffff:127.0.0.1. */
function isLocal(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}
