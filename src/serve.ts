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
import { Utterances, encodeWav, tooQuiet } from "./audio.ts";
import { settingsInForce, type Config } from "./config.ts";
import { Conversation } from "./conversation.ts";
import { Cues } from "./cues.ts";
import { LocalWhisper, textToSpeech } from "./speech.ts";
import { advertiseHost, livekitConfig, loadOrCreateKeys } from "./keys.ts";
import { Diagnostics } from "./diagnostics.ts";
import { Recorder } from "./record.ts";
import { qualityOf } from "./network.ts";
import { RTC_RATE, Transport, tokenFor } from "./transport.ts";

/** 12.2 one pairing, then a long-lived token the client keeps. */
function pairingCode(): string {
  const words = "amber,anchor,basalt,cedar,cobalt,dust,ember,fathom,garnet,harbour,indigo,jetty,kelp,lantern,marlin,north,onyx,pewter,quartz,rigging,slate,tide,umber,vellum,willow,zenith".split(",");
  return [0, 0, 0].map(() => words[Math.floor(Math.random() * words.length)]).join("-");
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
  const cues = new Cues(scratch, config.cueVolume);
  await Promise.all([stt.start(), tts.start(), cues.build()]);

  const transport = new Transport();
  const startedAt = Date.now();
  await transport.joinWhenReady(keys, config.room, config.livekitWaitMs, (text) => console.log(`[${text}]`));

  // 18 the record outlives the process: the scorecard is read after a drive,
  // and a restart in between used to leave nothing to read.
  const record = new Recorder(config.recordPath);
  record.session(settingsInForce(config));
  const diagnostics = new Diagnostics((event) => record.write(event));
  let counter = 0;
  /** 11.5 the ends of a turn, found in the frames the phone sends. */
  const utterances = new Utterances({
    sampleRate: RTC_RATE,
    pauseMs: config.endOfTurnPauseMs,
    onsetMs: config.speechOnsetMs,
    speechLevel: config.speechLevel,
    bargeInLevel: config.bargeInLevel,
    bargeInMs: config.bargeInMs,
    bargeInGapMs: config.bargeInGapMs,
  });

  /**
   * 9.5 muting is what makes the noise stop costing sentences. While muted the
   * bridge keeps transcribing, so "hey bridge, unmute" is still heard — it just
   * stops treating a lorry as a reason to shut up.
   */
  const bargingIn = () => utterances.bargingIn && !conversation.isMuted;

  const conversation = new Conversation(dir, config, {
    async say(text: string): Promise<boolean> {
      const wav = join(scratch, `say-${++counter}.wav`);
      await tts.synthesize(text, wav);
      console.log(`  ${text}`);
      // 11.3 stop the moment Chris starts to talk. The frames cannot hold the
      // bridge's own voice, because the client cancelled it before sending.
      // 18.4 the first sound of the answer closes the round trip. A later
      // sentence is not a round trip, and the tracker ignores it.
      const round = conversation.latency.answered();
      if (round) diagnostics.answered(round);
      const whole = await transport.speak(await Bun.file(wav).bytes(), bargingIn);
      if (!whole) console.log(`  [stopped: Chris started talking${bargedAt ? `, ${Date.now() - bargedAt}ms after it was noticed` : ""}]`);
      diagnostics.spoke(text, whole);
      return whole;
    },
    cue(name) {
      const wav = cues.file(name);
      if (!wav) return;
      void Bun.file(wav).bytes()
        .then((bytes) => transport.speak(bytes, bargingIn))
        .catch((error) => console.log(`[the cue failed: ${(error as Error).message}]`));
    },
    tell(value) { void transport.send(value); },
  }, stt, tts, {
    onNarration: (text) => { console.log(`[${text}]`); void transport.send({ kind: "narration", text }); },
    onTurn: (turn) => console.log(`[turn ${turn.number}, $${conversation.session.totalCostUsd().toFixed(4)} this session]`),
    onMatched: (said, became) => diagnostics.matched(said, became),
  });
  conversation.start();

  let wasActive = false;
  let bargedAt = 0;
  // 14.8 a client that dropped in a tunnel gets the turns it missed on the way back
  transport.onParticipant(() => {
    void transport.send({ kind: "history", turns: conversation.missed() });
  });

  transport.onAudio((frame) => {
    const said = utterances.push(frame);
    // 11.3 the moment Chris really starts, the bridge stops — every sentence,
    // not one. A recording opening is not enough: road noise opens recordings.
    if (bargingIn() !== wasActive) {
      wasActive = bargingIn();
      if (wasActive) {
        bargedAt = Date.now();
        // 18.6 what caused it, so the two thresholds stop being a guess
        const { level, heldMs } = utterances.bargeIn;
        console.log(`  [barge-in: level ${level.toFixed(3)}, held ${Math.round(heldMs)}ms]`);
        conversation.latency.barged(level, heldMs);
        diagnostics.barged(level, heldMs);
        conversation.stopSpeaking();
      }
    }
    if (!said) return;
    // 4.6 whisper writes words for near-silence even with its voice detector
    // on, and each invention costs a turn. Real speech is louder than this.
    if (tooQuiet(said, config.minSpeechPeak)) {
      diagnostics.heard(said, "", 0);
      console.log(`\n> (too quiet: peak ${said.peak.toFixed(2)}, under ${config.minSpeechPeak})`);
      conversation.heardNothing();
      return;
    }
    // 18.4 the clock starts on speech, and a lorry is not speech. Starting it
    // above the guard opened a round for every passing noise, and the next
    // sentence of the answer closed that one instead of the real one: an
    // eight-second round trip was recorded as one and a half.
    //
    // The end of the turn was the pause ago, not now. Measuring from here
    // would charge a setting to the round trip.
    conversation.latency.spoke(Date.now() - config.endOfTurnPauseMs, Date.now());
    conversation.cue("heard");
    const wav = join(scratch, `heard-${++counter}.wav`);
    const readAt = Date.now();
    void Bun.write(wav, encodeWav(said.samples, RTC_RATE))
      .then(() => stt.transcribe(wav))
      .then((text) => {
        conversation.latency.transcribed();
        const transcribeMs = Date.now() - readAt;
        diagnostics.heard(said, text, transcribeMs);
        // the shape of what was heard, which is what says whether a sentence
        // was cut in half: a short recording that is mostly quiet, arriving
        // one end-of-turn pause after the last one, is half a sentence
        console.log(
          `\n> ${text || "(nothing)"}` +
          `\n  [${(said.ms / 1000).toFixed(1)}s heard, ${(said.speechMs / 1000).toFixed(1)}s of speech in it, ` +
          `peak ${said.peak.toFixed(2)}, ${(said.gapMs / 1000).toFixed(1)}s quiet before, ` +
          `read in ${transcribeMs}ms]`,
        );
        // 11.3 road noise that carried no words must give the passage back
        if (!text) { conversation.heardNothing(); return; }
        return conversation.heard(text);
      })
      .catch((error) => {
        conversation.heardNothing();
        diagnostics.note(`could not read that: ${(error as Error).message}`);
        console.log(`[could not read that: ${(error as Error).message}]`);
      });
  });

  // 9.4.8 and 10.2 also reach the bridge as typed text from the client, because
  // a car is loud and a button is sometimes the honest way to say a thing.
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
      const on = value.on !== false;
      utterances.reset();
      console.log(`[the phone ${on ? "opened" : "cut"} its microphone]`);
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
          summary: diagnostics.summary(),
          settings: settingsInForce(config),
          latency: { rounds: conversation.latency.count, medianMs: conversation.latency.median(), worstMs: conversation.latency.worst() },
          network: { phone: conversation.network.get("phone"), bridge: conversation.network.get("bridge") },
          recent: diagnostics.recent(Number(url.searchParams.get("n") ?? 40)),
        });
      }
      if (url.pathname === "/health") {
        const well = transport.connected && conversation.session.running;
        return Response.json({
          ok: well,
          room: transport.connected ? "connected" : "gone",
          agent: conversation.session.running ? "running" : "stopped",
          engines: { speech: tts.sampleRate > 0, transcription: stt.warmupSeconds > 0 },
          network: { phone: conversation.network.get("phone"), bridge: conversation.network.get("bridge") },
          turns: conversation.session.turns,
          upSeconds: Math.round((Date.now() - startedAt) / 1000),
        }, { status: well ? 200 : 503 });
      }
      // 12.1 the boundary. Everything below here needs the code or a token.
      if (url.pathname === "/pair" && request.method === "POST") {
        const body = await request.json().catch(() => ({})) as { code?: string };
        if (body.code?.trim().toLowerCase() !== code) return Response.json({ error: "that code is not right" }, { status: 403 });
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

/** Loopback, in either family. Bun writes an IPv4 client on a dual-stack listener as ::ffff:127.0.0.1. */
function isLocal(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

export { livekitConfig };
