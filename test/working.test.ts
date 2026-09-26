import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HEARTBEAT_MS, Working, jobsRunning } from "../src/working.ts";

/** A working sign over two switches: whether a turn runs, and how many jobs run. */
function sign() {
  const said: boolean[] = [];
  const state = { turn: false, jobs: 0 };
  const w = new Working(() => state.turn, () => state.jobs, (on) => said.push(on));
  return { w, said, state };
}

describe("what the bridge says about work (14.10)", () => {
  test("it says nothing while it is idle", () => {
    const { w, said } = sign();
    for (let t = 0; t <= 20_000; t += 1_000) w.tick(t);
    expect(said).toEqual([]);
  });

  test("a turn says on when it starts and off when it ends", () => {
    const { w, said, state } = sign();
    state.turn = true;
    w.tick(1_000);
    expect(said).toEqual([true]);
    state.turn = false;
    w.tick(2_000);
    expect(said).toEqual([true, false]);
  });

  test("the message is repeated every heartbeat while the work lasts, and only then (14.10.2)", () => {
    const { w, said, state } = sign();
    state.turn = true;
    for (let t = 0; t <= 12_000; t += 1_000) w.tick(t);
    // at 0, then 5 s and 10 s later
    expect(said).toEqual([true, true, true]);
    expect(HEARTBEAT_MS).toBe(5_000);
    state.turn = false;
    w.tick(13_000);
    for (let t = 14_000; t <= 30_000; t += 1_000) w.tick(t);
    expect(said).toEqual([true, true, true, false]);
  });

  test("a job is work with no turn running, and it ends when the job does (14.10.4)", () => {
    const { w, said, state } = sign();
    state.jobs = 1;
    w.tick(0);
    expect(said).toEqual([true]);
    state.jobs = 0;
    // the job directories are read every two seconds, not every tick
    w.tick(1_000);
    expect(said).toEqual([true]);
    w.tick(2_000);
    expect(said).toEqual([true, false]);
  });

  test("a job and a turn together are one sign, and it stays on until both end", () => {
    const { w, said, state } = sign();
    state.turn = true;
    state.jobs = 1;
    w.tick(0);
    state.turn = false;
    w.tick(2_000);
    expect(said).toEqual([true]);
    state.jobs = 0;
    w.tick(4_000);
    expect(said).toEqual([true, false]);
  });
});

describe("which jobs are running (14.10.4)", () => {
  /** A jobs directory, as aleph leaves it: pid while it runs, exit when it ends. */
  function jobs(spec: Record<string, { pid?: string; exit?: string }>) {
    const dir = mkdtempSync(join(tmpdir(), "sidetone-jobs-"));
    for (const [id, files] of Object.entries(spec)) {
      mkdirSync(join(dir, id));
      if (files.pid !== undefined) writeFileSync(join(dir, id, "pid"), `${files.pid}\n`);
      if (files.exit !== undefined) writeFileSync(join(dir, id, "exit"), `${files.exit}\n`);
    }
    return dir;
  }
  /** The process table: each pid runs the command line given for it. */
  const table = (procs: Record<number, string>) => (pid: number) => procs[pid] ?? null;

  test("a job with a pid, no exit and a live process is running", () => {
    const dir = jobs({ "0921-a": { pid: "100" } });
    expect(jobsRunning(dir, table({ 100: `bash\0-c\0...\0job\0${dir}/0921-a\0a\0sleep` }))).toBe(1);
  });

  test("a job that wrote exit has ended, whatever runs at its pid", () => {
    const dir = jobs({ "0921-a": { pid: "100", exit: "0" } });
    expect(jobsRunning(dir, table({ 100: `bash\0${dir}/0921-a` }))).toBe(0);
  });

  test("a job that was killed and wrote no exit is not running: its process is gone", () => {
    const dir = jobs({ "0921-a": { pid: "100" } });
    expect(jobsRunning(dir, table({}))).toBe(0);
  });

  test("a pid that the machine gave to another process is not the job", () => {
    const dir = jobs({ "0921-a": { pid: "100" } });
    expect(jobsRunning(dir, table({ 100: "firefox\0--new-window" }))).toBe(0);
  });

  test("a job from before the pid file, and a directory that is not there, count for nothing", () => {
    const dir = jobs({ "0921-old": {} });
    expect(jobsRunning(dir, table({}))).toBe(0);
    expect(jobsRunning(join(dir, "missing"), table({}))).toBe(0);
  });

  test("each running job is counted", () => {
    const dir = jobs({ "a": { pid: "1" }, "b": { pid: "2" }, "c": { pid: "3", exit: "1" } });
    expect(jobsRunning(dir, table({ 1: `${dir}/a`, 2: `${dir}/b`, 3: `${dir}/c` }))).toBe(2);
  });
});

/**
 * The app trusts the sign for three heartbeats, and it has no settings file, so
 * the number is written in both ends. This fails when one moves without the other.
 */
test("the app waits three of the bridge's heartbeats before it shows no signal (17.11.3)", async () => {
  const app = await Bun.file(new URL("../android/app/src/main/java/dev/crsmith/sidetone/Work.kt", import.meta.url).pathname).text();
  const stale = /const val WORKING_STALE_MS = ([\d_]+)L/.exec(app)?.[1];
  expect(Number(stale?.replace(/_/g, ""))).toBe(3 * HEARTBEAT_MS);
});
