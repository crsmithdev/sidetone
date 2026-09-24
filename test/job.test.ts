import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * `scripts/job`, run for real against a jobs root of its own. Each run starts
 * a transient systemd user unit, so this needs a user manager. The say URL
 * points at the discard port: the connection is refused at once, and the
 * script does not mind.
 */
const script = new URL("../scripts/job", import.meta.url).pathname;

function run(root: string, name: string, ...command: string[]) {
  const p = Bun.spawnSync([script, name, ...command], {
    env: { ...process.env, SIDETONE_JOBS_DIR: root, SIDETONE_SAY_URL: "http://127.0.0.1:9/say" },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

/** Wait for the job at `dir` to write its exit file. */
async function ended(dir: string, ms = 10_000): Promise<string> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (existsSync(join(dir, "exit"))) return readFileSync(join(dir, "exit"), "utf8").trim();
    await Bun.sleep(100);
  }
  throw new Error(`no exit file in ${dir} after ${ms} ms`);
}

/** A job directory as the script leaves it while a job runs, with a live process that names the directory. */
function runningJob(root: string, id: string) {
  const dir = join(root, id);
  mkdirSync(dir);
  // two statements, or bash would exec sleep and the directory would leave the command line
  const proc = Bun.spawn(["bash", "-c", "sleep 60; true", "job", dir]);
  writeFileSync(join(dir, "pid"), `${proc.pid}\n`);
  return proc;
}

describe.skipIf(!Bun.which("systemd-run"))("scripts/job", () => {
  test("it writes the pid of the job's own process, not a dollar sign", async () => {
    const root = mkdtempSync(join(tmpdir(), "sidetone-job-"));
    const { code, out } = run(root, "pid-check", "true");
    expect(code).toBe(0);
    const dir = out.trim();
    expect(await ended(dir)).toBe("0");
    const pid = readFileSync(join(dir, "pid"), "utf8").trim();
    expect(pid).toMatch(/^[1-9][0-9]*$/);
    expect(readFileSync(join(dir, "command.txt"), "utf8")).toBe("true \n");
  });

  test("a name that is already running is refused, with a line to read aloud", () => {
    const root = mkdtempSync(join(tmpdir(), "sidetone-job-"));
    const proc = runningJob(root, "0924-112854-status-dot");
    try {
      const { code, out, err } = run(root, "status-dot", "true");
      expect(code).toBe(1);
      expect(out).toBe("");
      expect(err.trim()).toBe(
        "Job status-dot is already running, as 0924-112854-status-dot. Wait for it, or give this run another name.",
      );
      expect(readdirSync(root)).toEqual(["0924-112854-status-dot"]);
    } finally {
      proc.kill();
    }
  });

  test("the check is on the whole name: dot does not block status-dot", async () => {
    const root = mkdtempSync(join(tmpdir(), "sidetone-job-"));
    const proc = runningJob(root, "0924-112854-status-dot");
    try {
      const { code, out } = run(root, "dot", "true");
      expect(code).toBe(0);
      expect(await ended(out.trim())).toBe("0");
    } finally {
      proc.kill();
    }
  });

  test("a job whose process is gone and never wrote exit does not block the name", async () => {
    const root = mkdtempSync(join(tmpdir(), "sidetone-job-"));
    const gone = join(root, "0924-090000-wake-review");
    mkdirSync(gone);
    // a process that has ended: its pid is free, as after a restart of the machine
    const proc = Bun.spawn(["true"]);
    await proc.exited;
    writeFileSync(join(gone, "pid"), `${proc.pid}\n`);
    const { code, out, err } = run(root, "wake-review", "true");
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(await ended(out.trim())).toBe("0");
  });

  test("a pid that the machine gave to another process does not block the name", async () => {
    const root = mkdtempSync(join(tmpdir(), "sidetone-job-"));
    const reused = join(root, "0924-090000-wake-review");
    mkdirSync(reused);
    // alive, but its command line does not name the job directory (spec 14.10.4)
    const proc = Bun.spawn(["sleep", "60"]);
    try {
      writeFileSync(join(reused, "pid"), `${proc.pid}\n`);
      const { code, out } = run(root, "wake-review", "true");
      expect(code).toBe(0);
      expect(await ended(out.trim())).toBe("0");
    } finally {
      proc.kill();
    }
  });

  test("a job that ended frees its name, and the old directory holds a dollar-sign pid from before", async () => {
    const root = mkdtempSync(join(tmpdir(), "sidetone-job-"));
    const old = join(root, "0923-112853-wake-review");
    mkdirSync(old);
    writeFileSync(join(old, "pid"), "$\n");
    writeFileSync(join(old, "exit"), "0\n");
    const { code, out } = run(root, "wake-review", "true");
    expect(code).toBe(0);
    expect(await ended(out.trim())).toBe("0");
  });
});
