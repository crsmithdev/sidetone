import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Utterance } from "../src/audio.ts";
import { Diagnostics } from "../src/diagnostics.ts";
import { Recorder, readDrive } from "../src/record.ts";

const dirs: string[] = [];
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "record-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const utterance = (over: Partial<Utterance> = {}): Utterance => ({
  samples: new Int16Array(0), ms: 3_000, speechMs: 2_400, peak: 0.5,
  gapMs: 2_000, endedBy: "pause", ...over,
});

describe("the drive record", () => {
  test("it keeps what the process forgets", () => {
    const path = join(scratch(), "record.jsonl");
    const recorder = new Recorder(path);
    recorder.session({ minSpeechPeak: 0.15 }, 100);
    const d = new Diagnostics((event) => recorder.write(event));
    // more than the 120 a process holds, so the file is the longer memory
    for (let i = 0; i < 200; i++) d.heard(utterance(), `line ${i}`, 50, 200 + i);

    expect(d.recent(500).length).toBe(120);
    const drive = readDrive(path);
    expect(drive?.events.length).toBe(200);
    expect(drive?.settings).toEqual({ minSpeechPeak: 0.15 });
  });

  /**
   * The whole reason this is on disk. On 14 September the service restarted
   * twenty seconds after a drive and the scorecard printed zeros.
   */
  test("a restart after the drive does not take the drive with it", () => {
    const path = join(scratch(), "record.jsonl");
    const drove = new Recorder(path);
    drove.session({ cueVolume: 0.12 }, 100);
    const d = new Diagnostics((event) => drove.write(event));
    d.heard(utterance({ peak: 0.48 }), "hey bridge, stats", 150, 200);
    d.matched("hey bridge, stats", "stats", 210);

    // the process goes; the next one opens a session of its own. It speaks and
    // is talked over, but it never hears an utterance, so it is not a drive.
    const after = new Recorder(path);
    after.session({ cueVolume: 0.2 }, 9_000);
    const next = new Diagnostics((event) => after.write(event));
    next.spoke("Listening.", true, 9_100);
    next.barged(0.4, 400, 9_200);

    const drive = readDrive(path);
    expect(drive?.at).toBe(100);
    expect(drive?.settings).toEqual({ cueVolume: 0.12 });
    expect(drive?.events.map((e) => e.kind)).toEqual(["heard", "matched"]);
  });

  test("a line cut in half by a hard kill costs only that line", () => {
    const path = join(scratch(), "record.jsonl");
    const recorder = new Recorder(path);
    recorder.session({}, 100);
    const d = new Diagnostics((event) => recorder.write(event));
    d.heard(utterance(), "the keeper rang the bell", 150, 200);
    writeFileSync(path, `${'{"kind":"note","at":300,"text":"cut off'}`, { flag: "a" });

    expect(readDrive(path)?.events.length).toBe(1);
  });

  test("a record that cannot be written is not a reason to stop talking", () => {
    // a directory that is not there and cannot be made: the path runs through a file
    const dir = scratch();
    writeFileSync(join(dir, "wall"), "");
    const recorder = new Recorder(join(dir, "wall", "record.jsonl"));
    expect(() => recorder.session({}, 100)).not.toThrow();
    expect(() => recorder.write({ kind: "note", at: 200, text: "still going" })).not.toThrow();
  });

  test("there is nothing to score before the first drive", () => {
    expect(readDrive(join(scratch(), "missing.jsonl"))).toBeNull();
    const path = join(scratch(), "record.jsonl");
    new Recorder(path).session({}, 100);
    expect(readDrive(path)).toBeNull();
  });
});
