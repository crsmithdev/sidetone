import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeWav } from "../src/audio.ts";
import { ANNOUNCE_POLL_MS } from "../src/mouth.ts";
import { Pairing, routes, type Pass } from "../src/routes.ts";
import { bridge } from "./harness.ts";

/**
 * The HTTP routes (7.4, 12) over the bridge as the room assembles it, with no
 * `Bun.serve` and no room. A request from this machine comes from 127.0.0.1;
 * one from the tailnet does not.
 */
const HERE = "127.0.0.1";
const TAILNET = "100.68.96.43";
const PASS: Pass = { token: "t", url: "wss://bridge:7880", room: "sidetone" };

function site(options: { slept?: number[]; microphone?: boolean; sinceSound?: number | null } = {}) {
  const r = bridge();
  const pairing = new Pairing("kelp-cedar-jetty", async () => PASS, async (ms) => { options.slept?.push(ms); });
  const handle = routes({
    config: r.config,
    bridge: r,
    pairing,
    page: "<html>the page</html>",
    files: { sdk: "/nowhere/sdk.mjs", decoder: "/nowhere/decode.js", apk: "/nowhere/app.apk" },
    health: () => ({
      room: true,
      speech: true,
      transcription: true,
      microphone: options.microphone ?? true,
      sinceSound: options.sinceSound === undefined ? 120 : options.sinceSound,
    }),
    startedAt: Date.now(),
  });
  const post = (path: string, body: unknown, ip = HERE) =>
    handle(new Request(`http://bridge${path}`, { method: "POST", body: JSON.stringify(body) }), ip);
  const get = (path: string, ip = HERE) => handle(new Request(`http://bridge${path}`), ip);
  return { ...r, post, get };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("pairing, the boundary (12.1, ADR 0005)", () => {
  test("the right code gets the pass, whatever its case and spaces", async () => {
    const s = site();
    const response = await s.post("/pair", { code: " Kelp-Cedar-Jetty " }, TAILNET);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(PASS);
  });

  test("each wrong code makes the next one slower, to ten seconds, and the right one starts again", async () => {
    const slept: number[] = [];
    const pairing = new Pairing("kelp-cedar-jetty", async () => PASS, async (ms) => { slept.push(ms); });
    for (let i = 0; i < 22; i++) expect(await pairing.pair("amber-anchor-basalt")).toBeNull();
    expect(slept.slice(0, 3)).toEqual([500, 1_000, 1_500]);
    expect(slept.slice(-3)).toEqual([10_000, 10_000, 10_000]);
    expect(await pairing.pair("kelp-cedar-jetty")).toEqual(PASS);
    slept.length = 0;
    await pairing.pair("wrong");
    expect(slept).toEqual([500]);
  });

  test("a wrong code is refused through the route, and no code at all is a wrong code", async () => {
    const slept: number[] = [];
    const s = site({ slept });
    expect((await s.post("/pair", { code: "amber-anchor-basalt" }, TAILNET)).status).toBe(403);
    expect((await s.post("/pair", {}, TAILNET)).status).toBe(403);
    expect(slept).toEqual([500, 1_000]);
  });
});

describe("the routes for this machine only (12.1)", () => {
  for (const [method, path] of [["GET", "/diagnostics"], ["POST", "/say"], ["POST", "/play"]] as const) {
    test(`${method} ${path} is not found from the tailnet`, async () => {
      const s = site();
      const response = method === "GET" ? await s.get(path, TAILNET) : await s.post(path, { text: "x", file: "/x" }, TAILNET);
      expect(response.status).toBe(404);
    });
  }

  test("health says whether it works, not only whether it runs", async () => {
    const s = site();
    const response = await s.get("/health", TAILNET);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, room: "connected", agent: "running", engines: { speech: true, transcription: true } });
  });

  test("health says whether there is a microphone in the room (18.13.2)", async () => {
    expect(await (await site().get("/health", TAILNET)).json()).toMatchObject({ microphone: "open" });
    // a bridge with nothing to hear looks well, and the echo check passes when nothing can come back
    expect(await (await site({ microphone: false }).get("/health", TAILNET)).json()).toMatchObject({ microphone: "cut" });
  });

  test("health says how long since the microphone carried sound (18.13.3)", async () => {
    expect(await (await site({ sinceSound: 400 }).get("/health", TAILNET)).json()).toMatchObject({ soundMs: 400 });
    // a track can be open and carry nothing, which is the dead capture of 18.9
    expect(await (await site({ sinceSound: null }).get("/health", TAILNET)).json()).toMatchObject({ soundMs: null });
  });
});

describe("/say is one announcement (17.17)", () => {
  test("the client gets the words at once, and the voice says them when the bridge is free", async () => {
    const s = site();
    const response = await s.post("/say", { text: " Job build finished. " });
    expect(response.status).toBe(202);
    expect(s.told).toContainEqual({ kind: "narration", text: "Job build finished.", announce: true });
    expect(s.said).toEqual([]);
    await wait(ANNOUNCE_POLL_MS + 100);
    expect(s.said).toEqual(["Job build finished."]);
  });

  test("an empty line is refused", async () => {
    const s = site();
    expect((await s.post("/say", { text: "  " })).status).toBe(400);
    expect(s.told).toEqual([]);
  });
});

describe("/play goes through the mouth (15.12)", () => {
  test("a path that is not absolute, or not there, is refused", async () => {
    const s = site();
    expect((await s.post("/play", { file: "hold.mp3" })).status).toBe(400);
    expect((await s.post("/play", { file: "/nowhere/hold.mp3" })).status).toBe(400);
  });

  describe.skipIf(!Bun.which("ffmpeg"))("with a track", () => {
    const file = join(mkdtempSync(join(tmpdir(), "play-")), "track.wav");
    Bun.write(file, encodeWav(new Int16Array(4_800).fill(1_000), 48_000));

    test("it plays, and Chris talking stops it", async () => {
      const s = site();
      expect((await s.post("/play", { file })).status).toBe(202);
      await wait(ANNOUNCE_POLL_MS + 50);
      expect(s.tracks).toHaveLength(1);
      s.talk();
      await wait(20);
      expect(s.tracks[0]?.stopped).toBe(true);
    });

    test("it waits while the bridge speaks, then plays", async () => {
      const s = site();
      s.blockSay(true);
      s.mouth.reply("Muted.");
      expect((await s.post("/play", { file })).status).toBe(202);
      await wait(ANNOUNCE_POLL_MS + 50);
      expect(s.tracks).toHaveLength(0);
      s.release();
      s.blockSay(false);
      await s.mouth.drained();
      await wait(ANNOUNCE_POLL_MS + 50);
      expect(s.tracks).toHaveLength(1);
    });

    test("it is refused while the audio is off", async () => {
      const s = site();
      s.mouth.setAudio(false);
      const off = await s.post("/play", { file });
      expect(off.status).toBe(409);
      expect(await off.json()).toEqual({ error: "the audio is off" });
      expect(s.tracks).toHaveLength(0);
    });
  });
});
