import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Outgoing } from "../src/messages.ts";
import { PENDING_MS, Screenshots } from "../src/screenshot.ts";
import { bridge } from "./harness.ts";

function screenshots() {
  const dir = join(mkdtempSync(join(tmpdir(), "sidetone-screenshot-")), "screenshots");
  const told: Outgoing[] = [];
  return { dir, told, s: new Screenshots(dir, (message) => told.push(message)) };
}

/** Bytes that are not ASCII, so a wrong decode shows. */
const image = Buffer.from(Array.from({ length: 3_000 }, (_, n) => (n * 7) % 256));

/** The image as the app sends it: base64 in parts of `size` characters. */
function parts(id: string, bytes = image, size = 1_000) {
  const data = bytes.toString("base64");
  const count = Math.ceil(data.length / size);
  return Array.from({ length: count }, (_, n) => ({ kind: "screenshot", id, part: n + 1, of: count, data: data.slice(n * size, (n + 1) * size) }));
}

describe("the screenshot on disk (14.12)", () => {
  test("the parts of an image become one file, the journal hears of it once, and latest follows it", () => {
    const { dir, s } = screenshots();
    const file = join(dir, "1758472812345.jpg");
    const all = parts("1758472812345");
    expect(all.length).toBeGreaterThan(1);
    for (const part of all.slice(0, -1)) expect(s.receive(part)).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(s.receive(all.at(-1)!)).toEqual([`screenshot at ${file}`]);
    expect(readFileSync(file)).toEqual(image);
    expect(readlinkSync(join(dir, "latest.jpg"))).toBe("1758472812345.jpg");
  });

  test("parts out of order still make the image", () => {
    const { dir, s } = screenshots();
    for (const part of parts("a").reverse()) s.receive(part);
    expect(readFileSync(join(dir, "a.jpg"))).toEqual(image);
  });

  test("a new screenshot is a new file, and latest follows it", () => {
    const { dir, s } = screenshots();
    for (const part of parts("a")) s.receive(part);
    const other = Buffer.from("second");
    for (const part of parts("b", other)) s.receive(part);
    expect(readFileSync(join(dir, "a.jpg"))).toEqual(image);
    expect(readFileSync(join(dir, "b.jpg"))).toEqual(other);
    expect(readlinkSync(join(dir, "latest.jpg"))).toBe("b.jpg");
  });

  test("an image that is not whole when the next one starts is dropped and said", () => {
    const { dir, s } = screenshots();
    s.receive(parts("a")[0]!);
    const said = parts("b", Buffer.from("second")).flatMap((part) => s.receive(part));
    expect(said).toEqual(["the screenshot a from the phone was not whole, and is dropped", `screenshot at ${join(dir, "b.jpg")}`]);
    expect(existsSync(join(dir, "a.jpg"))).toBe(false);
  });

  test("a message that is not readable writes nothing and says so", () => {
    const { dir, s } = screenshots();
    for (const bad of [
      { kind: "screenshot" },
      { kind: "screenshot", id: "../escape", part: 1, of: 1, data: "" },
      { kind: "screenshot", id: "a", part: 1, of: 1, data: 7 },
      { kind: "screenshot", id: "a", part: 2, of: 1, data: "" },
      { kind: "screenshot", id: "a", part: 0, of: 1, data: "" },
      { kind: "screenshot", id: "a", part: 1, of: 1_000_000, data: "" },
    ]) expect(s.receive(bad)).toEqual(["a part of a screenshot from the phone was not readable"]);
    expect(existsSync(dir)).toBe(false);
  });

  test("a directory that cannot be made is said, not thrown", () => {
    const blocked = new Screenshots("/proc/sidetone-cannot-exist/screenshots");
    expect(blocked.receive(parts("a", Buffer.from("x"))[0]!)[0]).toStartWith("the screenshot was not written:");
  });
});

describe("a pending screenshot (14.12.6, 14.12.7)", () => {
  test("a written screenshot is pending, and the next turn takes it once", () => {
    const { dir, told, s } = screenshots();
    for (const part of parts("a")) s.receive(part, 1_000);
    expect(told).toEqual([{ kind: "screenshot", id: "a", state: "pending" }]);
    expect(s.take(2_000)).toEqual([join(dir, "a.jpg")]);
    expect(told.at(-1)).toEqual({ kind: "screenshot", id: "a", state: "sent" });
    expect(s.take(3_000)).toEqual([]);
  });

  test("several screenshots join one turn in the order they arrived", () => {
    const { dir, s } = screenshots();
    for (const part of parts("9")) s.receive(part, 1_000);
    for (const part of parts("1", Buffer.from("second"))) s.receive(part, 2_000);
    expect(s.take(3_000)).toEqual([join(dir, "9.jpg"), join(dir, "1.jpg")]);
  });

  test("a screenshot expires after about two minutes and joins no turn", () => {
    const { told, s } = screenshots();
    for (const part of parts("a")) s.receive(part, 0);
    expect(s.expire(PENDING_MS - 1)).toEqual([]);
    expect(s.expire(PENDING_MS)).toEqual(["the screenshot a expired before Chris said anything"]);
    expect(told.at(-1)).toEqual({ kind: "screenshot", id: "a", state: "expired" });
    expect(s.take(PENDING_MS)).toEqual([]);
  });

  test("the turn does not take a screenshot that expired since the last tick", () => {
    const { s } = screenshots();
    for (const part of parts("a")) s.receive(part, 0);
    expect(s.take(PENDING_MS + 500)).toEqual([]);
  });

  test("Chris drops a pending screenshot from the app", () => {
    const { told, s } = screenshots();
    for (const part of parts("a")) s.receive(part, 0);
    expect(s.receive({ kind: "screenshot", id: "a", drop: true })).toEqual(["Chris dropped the screenshot a"]);
    expect(told.at(-1)).toEqual({ kind: "screenshot", id: "a", state: "dropped" });
    expect(s.take(1)).toEqual([]);
    // one that is not pending, such as one a turn took already, is nothing to drop
    expect(s.receive({ kind: "screenshot", id: "a", drop: true })).toEqual([]);
  });
});

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !done(); i++) await new Promise((resolve) => setTimeout(resolve, 5));
}

describe("a pending screenshot and the turn (14.12.6)", () => {
  test("the next thing Chris says carries a line that names the file", async () => {
    const r = bridge();
    for (const part of parts("a")) r.channel.receive(part);
    r.channel.receive({ kind: "said", text: "what is doubled here" });
    await until(() => r.turns.length > 0);
    const ask = r.agent.calls.find((call) => call.startsWith("ask "))!;
    expect(ask).toContain(`It is at ${join(r.screenshots, "a.jpg")}. Open it if his words need it.`);
    expect(ask).toEndWith("what is doubled here");
    // the transcript shows what Chris said, not the line for the agent
    expect(r.told).toContainEqual({ kind: "heard", text: "what is doubled here" });
    expect(r.told).toContainEqual({ kind: "screenshot", id: "a", state: "sent" });
  });

  test("several screenshots are named in one line, in order", async () => {
    const r = bridge();
    for (const part of parts("a")) r.channel.receive(part);
    for (const part of parts("b", Buffer.from("second"))) r.channel.receive(part);
    r.channel.receive({ kind: "said", text: "look" });
    await until(() => r.turns.length > 0);
    const ask = r.agent.calls.find((call) => call.startsWith("ask "))!;
    expect(ask).toContain(`he took 2 screenshots of the app on the phone before he said this. In the order he took them, they are at ${join(r.screenshots, "a.jpg")}, ${join(r.screenshots, "b.jpg")}.`);
  });

  test("a screenshot alone does not wake the agent", async () => {
    const r = bridge();
    for (const part of parts("a")) r.channel.receive(part);
    await Bun.sleep(50);
    expect(r.agent.calls.filter((call) => call.startsWith("ask "))).toEqual([]);
    expect(r.told.filter((m) => m.kind === "screenshot")).toEqual([{ kind: "screenshot", id: "a", state: "pending" }]);
  });

  test("a screenshot that arrives after Chris speaks waits for the next turn", async () => {
    let end = () => {};
    const r = bridge({ script: { hold: new Promise<void>((resolve) => { end = resolve; }) } });
    r.channel.receive({ kind: "said", text: "first" });
    await until(() => r.agent.calls.some((call) => call.startsWith("ask ")));
    for (const part of parts("a")) r.channel.receive(part);
    end();
    await until(() => r.turns.length > 0);
    const first = r.agent.calls.find((call) => call.startsWith("ask "))!;
    expect(first).not.toContain("screenshot");
    expect(r.told.filter((m) => m.kind === "screenshot")).toEqual([{ kind: "screenshot", id: "a", state: "pending" }]);
  });

  test("a screenshot that arrives while an interrupted turn winds down waits for the turn after", async () => {
    let end = () => {};
    const r = bridge({
      overrides: { interruptOnSpeech: true, interruptAfterMs: 100 },
      script: { hold: new Promise<void>((resolve) => { end = resolve; }) },
    });
    r.channel.receive({ kind: "said", text: "first" });
    await until(() => r.agent.calls.some((call) => call.startsWith("ask ")));
    // Chris speaks mid-turn; the bridge waits for the old turn before it asks
    r.channel.receive({ kind: "said", text: "second" });
    for (const part of parts("a")) r.channel.receive(part);
    end();
    await until(() => r.agent.calls.filter((call) => call.startsWith("ask ")).length > 1);
    const second = r.agent.calls.filter((call) => call.startsWith("ask "))[1]!;
    expect(second).toEndWith("second");
    expect(second).not.toContain("a.jpg");
    expect(r.told.filter((m) => m.kind === "screenshot")).toEqual([{ kind: "screenshot", id: "a", state: "pending" }]);
  });
});
