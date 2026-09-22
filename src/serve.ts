/**
 * The bridge as a LiveKit participant, and the small server that lets a phone
 * reach it (spec 7.4, 12).
 *
 * The audio never touches the machine's own devices here. The phone opens the
 * microphone, LiveKit carries the frames, and the framework cancels the echo at
 * the client (4.2), so the bridge can keep listening while it speaks. That is
 * what makes barge-in possible at all (11.1 to 11.3), and it is why 11.4 says
 * not to hand-build a canceller.
 */
import { wavFromFile } from "./audio.ts";
import { ApkHash } from "./apk.ts";
import { assemble } from "./bridge.ts";
import { settingsInForce, type Config } from "./config.ts";
import type { Apk } from "./messages.ts";
import { advertiseHost, livekitConfig, loadOrCreateKeys } from "./keys.ts";
import { RTC_RATE, Transport, roomSpeaker, tokenFor } from "./transport.ts";
import { renderUnicodeCompact } from "uqr";

/** 12.2 one pairing, then a long-lived token the client keeps. */
function pairingCode(): string {
  const words = "amber,anchor,basalt,cedar,cobalt,dust,ember,fathom,garnet,harbour,indigo,jetty,kelp,lantern,marlin,north,onyx,pewter,quartz,rigging,slate,tide,umber,vellum,willow,zenith".split(",");
  return [0, 0, 0].map(() => words[Math.floor(Math.random() * words.length)]).join("-");
}

/**
 * 12.2 the address and the code in one scan, for the Android app (17). The code
 * goes in the fragment, so a phone camera that opens the link as a web page
 * never sends it to the server or into a log.
 */
export function pairingLink(origin: string, code: string): string {
  return `${origin}/#pair=${code}`;
}

/** What the phone must be told, which is never what the bridge itself dials. */
export function endpoints(config: Config) {
  const stored = loadOrCreateKeys();
  const host = config.advertiseHost || advertiseHost();
  const secure = Boolean(config.tlsCert && config.tlsKey);
  const scheme = secure || config.publicOrigin.startsWith("https:") ? "https" : "http";
  return {
    host,
    secure,
    keys: {
      apiKey: config.livekitApiKey || stored.apiKey,
      apiSecret: config.livekitApiSecret || stored.apiSecret,
      // the bridge is on the same machine as the server, so it dials the loopback
      url: config.livekitUrl || `ws://127.0.0.1:${config.livekitPort}`,
    },
    // the phone is not, so it is given what reaches this machine from outside
    origin: config.publicOrigin || `${scheme}://${host}:${config.servePort}`,
    // an https page may not open a ws:// socket, so this must be wss when it is
    clientUrl: config.livekitPublicUrl || `${scheme === "https" ? "wss" : "ws"}://${host}:${config.livekitPort}`,
  };
}

export async function serve(dir: string, config: Config): Promise<void> {
  const { host, keys, clientUrl, origin, secure } = endpoints(config);
  const transport = new Transport();
  const startedAt = Date.now();

  const bridge = assemble(dir, config, RTC_RATE, roomSpeaker(transport), (message) => { void transport.send(message); });
  const { channel, ear, mouth, conversation, measures, stt, tts } = bridge;

  // 17 the Android app, as the last `assembleDebug` in this checkout left it
  const apk = new URL("../android/app/build/outputs/apk/debug/app-debug.apk", import.meta.url).pathname;
  const apkHash = new ApkHash(apk);
  /** 17.15 the app a joining client is offered; none while nothing is built */
  const offer = async (): Promise<Apk | undefined> => {
    const sha256 = await apkHash.get();
    return sha256 ? { url: `${origin}/sidetone.apk`, sha256 } : undefined;
  };

  // The words are wired before the room is joined: the join can finish seconds
  // before the engines warm, and a phone that arrives in that window is owed
  // the protocol and the history at once, and its microphone cut must land.
  // 14.8 a client that dropped in a tunnel gets the turns it missed on the way back
  transport.onParticipant(async () => channel.joined(await offer()));
  // 18 what the drive of 18 September had no way to see: whether a microphone
  // track was there at all. The phone cut its own and reopened it, and every
  // line after that was about something else.
  transport.onMicrophone((on, sid) => console.log(`[the room ${on ? "has" : "lost"} a microphone track, ${sid}]`));
  transport.onMessage((value) => channel.receive(value));
  // N.1 this end's own reading. Both are kept: this one says whether the
  // machine is reaching the room, the phone's says whether the car is.
  transport.onQuality((quality, identity) => channel.quality(transport.isSelf(identity) ? "bridge" : "phone", quality));

  // the engines warm and the room is joined at the same time: whisper's warmup
  // is about seven seconds, and the wait for LiveKit does not need them
  try {
    await Promise.all([
      bridge.ready,
      transport.joinWhenReady(keys, config.room, config.livekitWaitMs, (text) => console.log(`[${text}]`)),
    ]);
  } catch (error) {
    // the agent and the engines were started for a room that never came
    bridge.stop();
    throw error;
  }
  // the frames need the engines; nothing is heard before they are warm
  transport.onAudio((frame) => ear.frame(frame));

  const code = pairingCode();
  /**
   * 12.1 three words drawn from twenty-six is 17,576 codes, and until
   * 15 September a wrong one cost nothing but the round trip. The port is open
   * to the tailnet for the phone, and a token is thirty days of joining the
   * room, hearing everything and driving the agent.
   *
   * Each wrong code now makes the next one slower, to ten seconds, which turns
   * the whole space into weeks. It does not stop a caller guessing down many
   * connections at once: the answer to that is a longer code, not a longer
   * wait, and the code is read out loud so it stays three words for now.
   */
  let wrongCodes = 0;
  const page = await Bun.file(new URL("../client/index.html", import.meta.url).pathname).text();
  const sdk = new URL("../node_modules/livekit-client/dist/livekit-client.esm.mjs", import.meta.url).pathname;

  const server = Bun.serve({
    port: config.servePort,
    hostname: "0.0.0.0",
    ...(secure ? { tls: { cert: Bun.file(config.tlsCert), key: Bun.file(config.tlsKey) } } : {}),
    async fetch(request, server) {
      const url = new URL(request.url);
      if (url.pathname === "/") return new Response(page, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/livekit-client.mjs") return new Response(Bun.file(sdk), { headers: { "content-type": "text/javascript" } });
      if (url.pathname === "/sidetone.apk") {
        if (!(await Bun.file(apk).exists())) return new Response("not built", { status: 404 });
        return new Response(Bun.file(apk), { headers: { "content-type": "application/vnd.android.package-archive", "content-disposition": 'attachment; filename="sidetone.apk"' } });
      }
      /**
       * Whether this is working, not whether it is running. Restart=always
       * cannot tell the difference: a process that holds a dead room, or has
       * lost the agent, looks exactly like a healthy one from outside. On
       * 13 September 2026 a crash loop went unnoticed for an hour because
       * nothing ever asked.
       */
      /**
       * Everything measured lately, for reading a session back afterwards.
       *
       * 12.1 this one carries the transcript: every word said and every word
       * answered. It is served to this machine only. The port is open to the
       * tailnet for the phone, and until 15 September anyone who could reach
       * it could read the conversation without the pairing code.
       */
      if (url.pathname === "/diagnostics") {
        if (!isLocal(server.requestIP(request)?.address)) return new Response("not found", { status: 404 });
        return Response.json({
          summary: measures.summary(),
          settings: settingsInForce(config),
          latency: measures.rounds(),
          network: { phone: conversation.network.get("phone"), bridge: conversation.network.get("bridge") },
          recent: measures.recent(count(url.searchParams.get("n"), 40)),
        });
      }
      if (url.pathname === "/health") {
        const well = transport.connected && conversation.agent.running;
        return Response.json({
          ok: well,
          room: transport.connected ? "connected" : "gone",
          agent: conversation.agent.running ? "running" : "stopped",
          engines: { speech: tts.sampleRate > 0, transcription: stt.warmupSeconds > 0 },
          network: { phone: conversation.network.get("phone"), bridge: conversation.network.get("bridge") },
          turns: conversation.agent.turns,
          upSeconds: Math.round((Date.now() - startedAt) / 1000),
        }, { status: well ? 200 : 503 });
      }
      /**
       * Play a file to the room: the first step of hold music. It is for a
       * shell on this machine, so the tailnet cannot reach it. The track
       * stops when Chris talks and when the bridge has a sentence to say, so
       * it never shares the source with a voice. It plays nothing, and stops,
       * while the audio is off (11.12).
       */
      if (url.pathname === "/play" && request.method === "POST") {
        if (!isLocal(server.requestIP(request)?.address)) return new Response("not found", { status: 404 });
        const body = await request.json().catch(() => ({})) as { file?: string };
        const file = body.file ?? "";
        // ffmpeg reads urls too; an absolute path is the one thing this takes
        if (!file.startsWith("/") || !(await Bun.file(file).exists())) {
          return Response.json({ error: "file must be the absolute path of a file that exists" }, { status: 400 });
        }
        let wav: Uint8Array;
        try { wav = await wavFromFile(file, RTC_RATE); }
        catch (error) { return Response.json({ error: (error as Error).message }, { status: 500 }); }
        // asked after the decode, which takes a second: a sentence may have started since
        if (!mouth.audioOn) return Response.json({ error: "the audio is off" }, { status: 409 });
        if (mouth.busy || transport.speaking) return Response.json({ error: "the bridge is speaking or playing" }, { status: 409 });
        console.log(`[playing ${file}]`);
        void transport.speak(wav, () => ear.bargingIn || mouth.busy || !mouth.audioOn)
          .then((whole) => console.log(whole ? "[the track ended]" : "[the track stopped]"))
          .catch((error) => console.log(`[the track failed: ${(error as Error).message}]`));
        return Response.json({ playing: file }, { status: 202 });
      }
      /**
       * Say one line when the bridge is free: `scripts/job` tells Chris here
       * that a detached job ended. The same guard as /play: a shell on this
       * machine only.
       */
      if (url.pathname === "/say" && request.method === "POST") {
        if (!isLocal(server.requestIP(request)?.address)) return new Response("not found", { status: 404 });
        const body = await request.json().catch(() => ({})) as { text?: string };
        const text = body.text?.trim() ?? "";
        if (!text) return Response.json({ error: "text must be a line to say" }, { status: 400 });
        console.log(`[to say when free: ${text}]`);
        mouth.announce(text, () => !conversation.busy);
        // 17.17 the words go to the app at once, which notifies them when it is not in front
        channel.tell({ kind: "narration", text, announce: true });
        return Response.json({ queued: text }, { status: 202 });
      }
      // 12.1 the boundary. Everything below here needs the code or a token.
      if (url.pathname === "/pair" && request.method === "POST") {
        const body = await request.json().catch(() => ({})) as { code?: string };
        if (body.code?.trim().toLowerCase() !== code) {
          wrongCodes++;
          await Bun.sleep(Math.min(wrongCodes, 20) * 500);
          return Response.json({ error: "that code is not right" }, { status: 403 });
        }
        wrongCodes = 0;
        const token = await tokenFor(keys, config.room, `phone-${Date.now()}`, config.tokenDays * 24);
        // 12.3 the same answer serves the web client and the Android app. The url
        // is the one the phone can reach, never the loopback the bridge dials.
        return Response.json({ token, url: clientUrl, room: config.room });
      }
      return new Response("not found", { status: 404 });
    },
  });

  console.log(`bridge on ${origin}, room ${config.room}, Claude Code in ${dir}`);
  console.log(`the phone reaches LiveKit at ${clientUrl}`);
  if (origin.startsWith("http://") && !origin.includes("127.0.0.1") && !origin.includes("localhost")) {
    // saying this plainly here is cheaper than finding it on the phone
    console.log("warning: a browser gives no microphone to a page that is not https, except on loopback");
  }
  console.log(`pair the phone with this code: ${code}`);
  // light blocks on a dark terminal, which is the way round a scanner reads
  console.log(renderUnicodeCompact(pairingLink(origin, code)));

  // Leave the room on the way out. Without this the participant slot lingers,
  // and the process that replaces this one arrives to find itself already
  // there under another name.
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      void (async () => {
        console.log(`[${signal}: leaving the room]`);
        try { await transport.close(); } catch { /* going anyway */ }
        bridge.stop();
        server.stop();
        process.exit(0);
      })();
    });
  }
  await new Promise(() => {});
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

export { livekitConfig };
