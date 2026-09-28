import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Channel, type Ends } from "../src/channel.ts";
import { receiveCrash } from "../src/crash.ts";
import { DEFAULTS } from "../src/config.ts";
import { readDevice } from "../src/device.ts";
import { decodeIncoming, type Incoming } from "../src/messages.ts";
import { receivedLine } from "../src/network.ts";
import { Screens } from "../src/screen.ts";
import { Screenshots } from "../src/screenshot.ts";

/**
 * 4.3 the control channel from a client to the bridge (ADR 0007).
 *
 * `test/fixtures/from-app.jsonl` is what the app's own encoders write:
 * `MessagesTest.writesEverythingTheAppSends` writes it on every Gradle test
 * run. The page's messages are below, checked against `client/index.html`.
 */
const FROM_APP = new URL("./fixtures/from-app.jsonl", import.meta.url).pathname;
const PAGE = new URL("../client/index.html", import.meta.url).pathname;

/** Every kind a client may send, and the end each reaches. A kind added to `Incoming` must be added here. */
const REACHES: Record<Incoming["kind"], keyof Ends> = {
  said: "heard", mic: "microphone", voice: "voice", setting: "setting", music: "music", quality: "quality", receive: "receive",
  screen: "screen", screenshot: "screenshot", crash: "crash", device: "device",
};

/**
 * The page's `tell` payloads in `client/index.html`, with a value in place of
 * each variable: the quality (~183), the microphone button (~252), the text
 * box (~280) and the Stop button (~287). The page is one inline script, so
 * the test reads the literals from it below to keep this list honest.
 */
const FROM_PAGE: Array<Record<string, unknown>> = [
  { kind: "quality", quality: "good" },
  { kind: "mic", on: false },
  { kind: "said", text: "what is two plus two" },
  { kind: "said", text: "sidetone end the turn" },
];

const read = async (path: string) => (await Bun.file(path).text()).trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);

/** A channel whose ends write down which end each message reached, and hand the four parts to the modules that read them. */
function channel() {
  const dir = mkdtempSync(join(tmpdir(), "sidetone-incoming-"));
  const reached: string[] = [];
  const journal: string[] = [];
  const screens = new Screens(join(dir, "screen"));
  const screenshots = new Screenshots(join(dir, "screenshots"));
  const ends: Ends = {
    heard: async () => { reached.push("heard"); },
    microphone: () => { reached.push("microphone"); },
    voice: () => { reached.push("voice"); },
    setting: () => { reached.push("setting"); },
    music: () => { reached.push("music"); },
    quality: () => { reached.push("quality"); return true; },
    receive: (value) => { reached.push("receive"); return receivedLine(value); },
    screen: (part) => { reached.push("screen"); return screens.receive(part); },
    screenshot: (part) => { reached.push("screenshot"); return screenshots.receive(part); },
    crash: (report) => { reached.push("crash"); return receiveCrash(report, join(dir, "crashes")); },
    device: async (value) => { reached.push("device"); return readDevice(value, undefined).line; },
  };
  const c = new Channel(DEFAULTS, () => {}, ends, (line) => journal.push(line));
  return { c, reached, journal };
}

describe("what a client sends the bridge (4.3, ADR 0007)", () => {
  test("the bridge reads every message the app's encoders write, and each reaches its end", async () => {
    const sent = await read(FROM_APP);
    const { c, reached, journal } = channel();
    for (const [at, message] of sent.entries()) {
      const decoded = decodeIncoming(message);
      expect(decoded, `line ${at + 1} of from-app.jsonl`).not.toBeNull();
      expect(decoded!.kind).toBe(message.kind as Incoming["kind"]);
      c.receive(message);
      expect(reached.at(-1), `line ${at + 1} of from-app.jsonl`).toBe(REACHES[decoded!.kind]);
    }
    await Bun.sleep(0);
    // the four the modules read say where the part went, never that it was not readable
    expect(journal.filter((line) => line.includes("not readable"))).toEqual([]);
    // every kind the bridge reads has an encoder in the app, so no kind is the bridge's alone
    expect([...new Set(sent.map((m) => m.kind))].sort()).toEqual(Object.keys(REACHES).sort());
  });

  test("the app's hold to talk press and let go reach the microphone as a hold (9.5)", async () => {
    const mics = (await read(FROM_APP)).map(decodeIncoming).filter((m) => m?.kind === "mic");
    expect(mics).toEqual([
      { kind: "mic", on: false, hold: false, release: false },
      { kind: "mic", on: true, hold: false, release: false },
      { kind: "mic", on: true, hold: true, release: false },
      { kind: "mic", on: false, hold: false, release: true },
    ]);
  });

  test("the bridge reads every message the page sends", async () => {
    for (const message of FROM_PAGE) expect(decodeIncoming(message)?.kind).toBe(message.kind as Incoming["kind"]);
    // the list above has the kinds and the fields of each `tell` in the page, and no more
    const page = await Bun.file(PAGE).text();
    const told = [...page.matchAll(/tell\(\{ ([^}]*) \}\)/g)].map(([, body]) =>
      body!.split(",").map((field) => field.trim().split(":")[0]).join(" "));
    expect(told.sort()).toEqual(FROM_PAGE.map((m) => Object.keys(m).join(" ")).sort());
  });

  test("a message the bridge does not read is dropped, and the journal says so", () => {
    const { c, reached, journal } = channel();
    c.receive({ kind: "stats" });
    c.receive({ kind: "said" });
    c.receive({ kind: "setting", patch: "tones" });
    c.receive({});
    expect(reached).toEqual([]);
    expect(journal).toEqual([
      '[a message of kind "stats" from a client was not readable]',
      '[a message of kind "said" from a client was not readable]',
      '[a message of kind "setting" from a client was not readable]',
      "[a message of kind null from a client was not readable]",
    ]);
  });
});
