import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Screens } from "../src/screen.ts";

const at = new Date("2026-09-21T16:40:12.345Z");

function screens() {
  const dir = join(mkdtempSync(join(tmpdir(), "sidetone-screen-")), "screen");
  return { dir, s: new Screens(dir, () => at) };
}

const entry = (n: number) => ({ at: 1_000 + n, time: "16:40:12.345", kind: "delta", answer: 1, block: 1, bubble: 3, got: "x", text: `words ${n}` });

describe("the screen log on disk (14.11)", () => {
  test("a log in one part is written to a file named for the time, one entry to a line", () => {
    const { dir, s } = screens();
    const said = s.receive({ kind: "screen", id: "a", part: 1, of: 1, entries: [entry(1), entry(2)] });
    const file = join(dir, "2026-09-21T16-40-12.345Z.jsonl");
    expect(said).toEqual([`screen log written to ${file}, 2 lines`]);
    const lines = readFileSync(file, "utf8").split("\n");
    expect(lines.pop()).toBe("");
    expect(lines.map((line) => JSON.parse(line))).toEqual([entry(1), entry(2)]);
  });

  test("a log in parts is written once, when the last part arrives, in the order of the parts", () => {
    const { dir, s } = screens();
    expect(s.receive({ kind: "screen", id: "a", part: 1, of: 3, entries: [entry(1)] })).toEqual([]);
    expect(s.receive({ kind: "screen", id: "a", part: 3, of: 3, entries: [entry(3)] })).toEqual([]);
    expect(existsSync(dir)).toBe(false);
    const said = s.receive({ kind: "screen", id: "a", part: 2, of: 3, entries: [entry(2)] });
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("3 lines");
    const file = join(dir, readdirSync(dir)[0]!);
    expect(readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line).text)).toEqual(["words 1", "words 2", "words 3"]);
  });

  test("a log that is empty still writes a file, which says the screen showed nothing", () => {
    const { dir, s } = screens();
    expect(s.receive({ kind: "screen", id: "a", part: 1, of: 1, entries: [] })[0]).toContain("0 lines");
    expect(readFileSync(join(dir, readdirSync(dir)[0]!), "utf8")).toBe("");
  });

  test("a new log drops the one that did not arrive whole, and says so", () => {
    const { dir, s } = screens();
    s.receive({ kind: "screen", id: "a", part: 1, of: 2, entries: [entry(1)] });
    const said = s.receive({ kind: "screen", id: "b", part: 1, of: 1, entries: [entry(2)] });
    expect(said[0]).toContain("did not arrive whole");
    expect(said[1]).toContain("1 lines");
    expect(readdirSync(dir)).toHaveLength(1);
  });

  test("a part that is not readable writes nothing and says so", () => {
    const { dir, s } = screens();
    for (const bad of [
      { kind: "screen" },
      { kind: "screen", id: "a", part: 0, of: 1, entries: [] },
      { kind: "screen", id: "a", part: 2, of: 1, entries: [] },
      { kind: "screen", id: "a", part: 1, of: 1_000_000, entries: [] },
      { kind: "screen", id: "a", part: 1, of: 1, entries: "no" },
    ]) expect(s.receive(bad)).toEqual(["a part of the screen log from the phone was not readable"]);
    expect(existsSync(dir)).toBe(false);
  });

  test("a directory that cannot be made is said, not thrown", () => {
    const blocked = new Screens("/proc/sidetone-cannot-exist/screen", () => at);
    const said = blocked.receive({ kind: "screen", id: "a", part: 1, of: 1, entries: [entry(1)] });
    expect(said[0]).toStartWith("the screen log was not written:");
  });
});
