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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav } from "./audio.ts";
import { saveSettings, settingsInForce, type Config } from "./config.ts";
import { Conversation, keptLines } from "./conversation.ts";
import { Cues } from "./cues.ts";
import { Ear, earOptions, SILENCE_MS } from "./ear.ts";
import { protocolMessage } from "./messages.ts";
import { LocalWhisper, SpokenAhead, textToSpeech } from "./speech.ts";
import { advertiseHost, livekitConfig, loadOrCreateKeys } from "./keys.ts";
import { Measures } from "./measures.ts";
import { Mouth } from "./mouth.ts";
import { Recorder } from "./record.ts";
import { qualityOf } from "./network.ts";
import { RTC_RATE, Transport, tokenFor } from "./transport.ts";
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
  const scratch = mkdtempSync(join(tmpdir(), "voice-bridge-"));
  const { host, keys, clientUrl, origin, secure } = endpoints(config);
  const speechDir = new URL("../speech", import.meta.url).pathname;
  const stt = new LocalWhisper(config, speechDir);
  const tts = textToSpeech(config, speechDir);
  const ahead = new SpokenAhead(tts, scratch, keptLines(config));
  const cues = new Cues(scratch, config.cueVolume);
  await Promise.all([stt.start(), tts.start(), cues.build()]);

  const transport = new Transport();
  const startedAt = Date.now();
  await transport.joinWhenReady(keys, config.room, config.livekitWaitMs, (text) => console.log(`[${text}]`));

  // 18 the record outlives the process: the scorecard is read after a drive,
  // and a restart in between used to leave nothing to read.
  const record = new Recorder(config.recordPath);
  record.session(settingsInForce(config));
  // 18 one bookkeeper: the spoken report and the record are the same facts
  const measures = new Measures((event) => record.write(event));
  let counter = 0;
  const bargingIn = () => ear.bargingIn;

  /** 7.4 the one thing the room does that the desk does not: it plays over LiveKit. */
  const mouth = new Mouth({
    async play(text, wav) {
      console.log(`  ${text}`);
      if (!wav) return true;
      // 11.3 stop the moment Chris starts to talk. The frames cannot hold the
      // bridge's own voice, because the client cancelled it before sending.
      const whole = await transport.speak(await Bun.file(wav).bytes(), bargingIn);
      if (!whole) console.log(`  [stopped: Chris started talking${ear.bargedAt ? `, ${Date.now() - ear.bargedAt}ms after it was noticed` : ""}]`);
      return whole;
    },
    cue(wav) {
      void Bun.file(wav).bytes()
        // The mouth checked that nothing was speaking before this read began.
        // If that changed while the file was read, the cue is late: a cue means
        // "still working", and behind a whole answer it means nothing.
        .then((bytes) => (transport.speaking ? false : transport.speak(bytes, bargingIn)))
        .catch((error) => console.log(`[the cue failed: ${(error as Error).message}]`));
    },
  }, ahead, cues, measures, config);

  const conversation = new Conversation(dir, config, mouth, tts, {
    onNarration: (text) => { console.log(`[${text}]`); void transport.send({ kind: "narration", text }); },
    tell: (value) => { void transport.send(value); },
    onSetting: (patch) => saveSettings(patch),
    onTurn: (turn) => console.log(`[turn ${turn.number}, $${conversation.agent.totalCostUsd().toFixed(4)} this session]`),
    onMatched: (said, became) => {
      measures.matched(said, became);
      // 9.7 holds for the command still on its way and says nothing meanwhile,
      // which is right. Saying nothing anywhere is not: on 18 September the
      // agent told Chris four times to put the wake word in front of a
      // sentence, five sentences went this way, and neither end could see it.
      if (became !== "waiting for the command") return;
      const text = `the wake word arrived with no command, so nothing was done with: "${said}"`;
      console.log(`[${text}]`);
      void transport.send({ kind: "narration", text });
    },
  });
  conversation.start();

  /** 11.5 and 18.4 entire: the listening policy, one module, driven by frames. */
  const ear = new Ear(conversation, async (utterance) => {
    const wav = join(scratch, `heard-${++counter}.wav`);
    await Bun.write(wav, encodeWav(utterance.samples, RTC_RATE));
    return stt.transcribe(wav);
  }, earOptions(config, RTC_RATE), measures);

  // 14.8 a client that dropped in a tunnel gets the turns it missed on the way back
  transport.onParticipant(() => {
    // 4.3 what only the bridge knows: the words a client has to say back to it
    void transport.send(protocolMessage(config));
    void transport.send({ kind: "history", turns: conversation.missed() });
  });

  transport.onAudio((frame) => ear.frame(frame));

  // 18 what the drive of 18 September had no way to see: whether a microphone
  // track was there at all. The phone cut its own and reopened it, and every
  // line after that was about something else.
  transport.onMicrophone((on, sid) => console.log(`[the room ${on ? "has" : "lost"} a microphone track, ${sid}]`));

  /** Whether the phone says its microphone is open; it only warns about one it claims to have. */
  let micOn = true;
  let said = false;

  /**
   * A microphone that publishes nothing, or publishes zeroes, is the failure
   * Chris drove twenty minutes with. It is not a state the bridge can mend from
   * this end -- the track belongs to the phone -- so it says so, on the journal
   * and in the client, and says what does mend it.
   */
  setInterval(() => {
    const silence = micOn ? ear.silence() : null;
    if (!silence) { said = false; return; }
    if (said) return;
    said = true;
    const text = silence.kind === "no frames"
      ? `no audio from the phone for ${Math.round(silence.ms / 1000)}s, though it says its microphone is open`
      : `the phone's microphone has carried no sound at all for ${Math.round(silence.ms / 1000)}s`;
    console.log(`[${text}: leave the room and rejoin to publish a new track]`);
    void transport.send({ kind: "narration", text });
  }, SILENCE_MS / 3);

  transport.onMessage((value) => {
    if (value.kind === "said" && typeof value.text === "string") void conversation.heard(value.text);
    // N.1.4 the phone's own reading of its uplink. Measured on a real room,
    // this end sees the phone's quality too, so the two are the same signal
    // arriving twice and the tracker ignores the repeat. It is kept because
    // either source can go quiet, and the phone's is the one that survives a
    // link the bridge has stopped hearing from.
    // N/A to the spec, and asked for after a session where the microphone kept
    // picking up half sentences: a hard cut the phone controls. Anything half
    // recorded goes with it, or it arrives as a fragment on the way back.
    if (value.kind === "mic") {
      micOn = value.on !== false;
      // the hold goes with the half recording, or nothing resolves it
      ear.reset();
      said = false;
      console.log(`[the phone ${micOn ? "opened" : "cut"} its microphone]`);
    }
    // 11.12 asked for after a drive: somewhere the bridge must not be heard.
    if (value.kind === "voice") {
      const voice = value.on !== false;
      mouth.setVoice(voice);
      const text = voice ? "the voice is on" : "the voice is off; the words carry on in the transcript";
      console.log(`[${text}]`);
      void transport.send({ kind: "narration", text });
    }
    if (value.kind === "quality") {
      const quality = qualityOf(value.quality);
      if (conversation.network.saw("phone", quality)) console.log(`[the phone's connection is ${quality}]`);
    }
  });

  // N.1 this end's own reading. Both are kept: this one says whether the
  // machine is reaching the room, the phone's says whether the car is.
  transport.onQuality((quality, identity) => {
    const seen = qualityOf(quality);
    // the bridge is told about every participant, including itself
    const side = transport.isSelf(identity) ? "bridge" : "phone";
    if (conversation.network.saw(side, seen)) console.log(`[${side === "bridge" ? "this end" : "the phone"} reports ${seen}]`);
  });

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
        conversation.stop();
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
