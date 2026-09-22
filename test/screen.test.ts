import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Screens } from "../src/screen.ts";

function screens() {
  const dir = join(mkdtempSync(join(tmpdir(), "sidetone-screen-")), "screen");
  return { dir, s: new Screens(dir) };
}

const entry = (n: number) => ({ at: 1_000 + n, time: "16:40:12.345", kind: "delta", answer: 1, block: 1, bubble: 3, got: "x", text: `words ${n}` });
const read = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line).text);

describe("the screen log on disk (14.11)", () => {
  test("entries are appended to the file of their log, one to a line, and the journal hears of a new log once", () => {
    const { dir, s } = screens();
    const file = join(dir, "1758472812345.jsonl");
    expect(s.receive({ kind: "screen", id: "1758472812345", entries: [entry(1), entry(2)] })).toEqual([`screen log at ${file}`]);
    expect(s.receive({ kind: "screen", id: "1758472812345", entries: [entry(3)] })).toEqual([]);
    expect(read(file)).toEqual(["words 1", "words 2", "words 3"]);
    expect(readlinkSync(join(dir, "latest.jsonl"))).toBe("1758472812345.jsonl");
  });

  test("a new log of the app starts a new file, and latest follows it", () => {
    const { dir, s } = screens();
    s.receive({ kind: "screen", id: "a", entries: [entry(1)] });
    expect(s.receive({ kind: "screen", id: "b", entries: [entry(2)] })).toEqual([`screen log at ${join(dir, "b.jsonl")}`]);
    expect(read(join(dir, "a.jsonl"))).toEqual(["words 1"]);
    expect(readlinkSync(join(dir, "latest.jsonl"))).toBe("b.jsonl");
  });

  test("a message that is not readable writes nothing and says so", () => {
    const { dir, s } = screens();
    for (const bad of [
      { kind: "screen" },
      { kind: "screen", id: "../escape", entries: [] },
      { kind: "screen", id: "a", entries: "no" },
    ]) expect(s.receive(bad)).toEqual(["a part of the screen log from the phone was not readable"]);
    expect(existsSync(dir)).toBe(false);
  });

  test("a directory that cannot be made is said, not thrown", () => {
    const blocked = new Screens("/proc/sidetone-cannot-exist/screen");
    expect(blocked.receive({ kind: "screen", id: "a", entries: [entry(1)] })[0]).toStartWith("the screen log was not written:");
  });
});
