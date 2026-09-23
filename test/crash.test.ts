import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { receiveCrash } from "../src/crash.ts";

function crashes() {
  return join(mkdtempSync(join(tmpdir(), "sidetone-crash-")), "crashes");
}

describe("the crash report on disk (14.14)", () => {
  test("a report becomes one file, and the journal hears where", () => {
    const dir = crashes();
    const text = "time: 2026-09-23T10:00:00Z\njava.lang.IllegalStateException: the microphone was not published\n\tat dev.crsmith.sidetone.Bridge.openMic(Bridge.kt:365)\n";
    const file = join(dir, "1758621600000.txt");
    expect(receiveCrash({ kind: "crash", id: "1758621600000", text }, dir)).toBe(`crash report at ${file}`);
    expect(readFileSync(file, "utf8")).toBe(text);
  });

  test("a message that is not readable writes nothing and says so", () => {
    const dir = crashes();
    for (const bad of [
      { kind: "crash" },
      { kind: "crash", id: "../escape", text: "" },
      { kind: "crash", id: "a", text: 7 },
    ]) expect(receiveCrash(bad, dir)).toBe("a crash report from the phone was not readable");
    expect(existsSync(dir)).toBe(false);
  });

  test("a directory that cannot be made is said, not thrown", () => {
    expect(receiveCrash({ kind: "crash", id: "a", text: "x" }, "/proc/sidetone-cannot-exist/crashes")).toStartWith("the crash report was not written:");
  });
});
