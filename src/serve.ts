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
import { ApkHash, watchApk } from "./apk.ts";
import { assemble } from "./bridge.ts";
import { Outbound } from "./outbound.ts";
import type { Config } from "./config.ts";
import type { Apk } from "./messages.ts";
import { advertiseHost, livekitConfig, loadOrCreateKeys } from "./keys.ts";
import { Pairing, routes } from "./routes.ts";
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

  // 14.11 one exit, which measures, orders and never lets a failed message
  // out as an unhandled rejection: that exits the process and takes the agent
  // session with it.
  const outbound = new Outbound((payload) => transport.publish(payload));
  const bridge = assemble(dir, config, RTC_RATE, roomSpeaker(transport), (message) => outbound.send(message));
  const { channel, ear, stt, tts } = bridge;

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

  const code = pairingCode();
  const pairing = new Pairing(code, async () => ({
    token: await tokenFor(keys, config.room, `phone-${Date.now()}`, config.tokenDays * 24),
    url: clientUrl,
    room: config.room,
  }));
  const handle = routes({
    config,
    bridge,
    pairing,
    page: await Bun.file(new URL("../client/index.html", import.meta.url).pathname).text(),
    files: {
      sdk: new URL("../node_modules/livekit-client/dist/livekit-client.esm.mjs", import.meta.url).pathname,
      // 4.3 the page's reading of a message, which a test replays the fixture through
      decoder: new URL("../client/decode.js", import.meta.url).pathname,
      apk,
    },
    health: () => ({ room: transport.connected, speech: tts.sampleRate > 0, transcription: stt.warmupSeconds > 0 }),
    startedAt,
  });

  const server = Bun.serve({
    port: config.servePort,
    hostname: "0.0.0.0",
    ...(secure ? { tls: { cert: Bun.file(config.tlsCert), key: Bun.file(config.tlsKey) } } : {}),
    fetch: (request, server) => handle(request, server.requestIP(request)?.address),
  });

  // The port opens before the engines are warm, and answers /health while they
  // warm. It used to open after, and on 23 September 2026 that cost the bridge
  // its own restart loop: chatterbox takes about 160 seconds to load, the
  // health probe runs every 120, and each failed probe restarted the service
  // before it could finish. Nothing on the port needs a warm engine.
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
    server.stop();
    throw error;
  }
  // the frames need the engines; nothing is heard before they are warm
  transport.onAudio((frame) => ear.frame(frame));
  // 17.15.5 a build that ends while a client is in the room; the process exit stops it
  watchApk(apkHash, (sha256) => channel.tell({ kind: "apk", apk: { url: `${origin}/sidetone.apk`, sha256 } }));

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

export { livekitConfig };
