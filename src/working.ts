/**
 * Whether the agent is working, said to the client (spec 14.10).
 *
 * The audio can be cut, and the hold music is quiet by design, so the client
 * cannot tell a turn that runs from an idle bridge by sound. The bridge says
 * it. The message is a heartbeat: the client trusts the sign only while it
 * keeps arriving, so a bridge that is stuck does not look like one that works.
 *
 * Two things are work. A turn is one (`Conversation.busy`). A detached job is
 * the other: aleph writes a directory for each job run, and the bridge reads
 * it. It measures and says; it decides nothing.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** aleph writes one directory here for each run: `aleph job`, `aleph run` and `aleph land`. */
export const JOBS_DIR = join(homedir(), ".aleph", "jobs");

/** 14.10.2 how often the bridge repeats "on" while the work lasts. The app trusts the sign for three of these. */
export const HEARTBEAT_MS = 5_000;

/** How often the job directories are read. A job that starts or ends shows within this. */
const SCAN_MS = 2_000;

function read(path: string): string | null {
  try { return readFileSync(path, "utf8"); } catch { return null; }
}

/** The command line of a process, or null when it is gone. */
export const commandLine = (pid: number): string | null => read(`/proc/${pid}/cmdline`);

/**
 * 14.10.4 how many detached jobs run now. A job runs when it has a pid, has no
 * `exit` file, and its process is still there with the job's directory in its
 * command line. The last check is what a pid that the machine reused, or a job
 * that was killed and never wrote `exit`, cannot pass.
 */
export function jobsRunning(dir = JOBS_DIR, cmdline = commandLine): number {
  let ids: string[];
  try { ids = readdirSync(dir); } catch { return 0; }
  let running = 0;
  for (const id of ids) {
    const job = join(dir, id);
    if (existsSync(join(job, "exit"))) continue;
    const pid = Number(read(join(job, "pid")));
    if (Number.isInteger(pid) && pid > 0 && cmdline(pid)?.includes(job)) running++;
  }
  return running;
}

export class Working {
  private on = false;
  private sentAt = 0;
  private jobs = 0;
  private scannedAt = -Infinity;

  constructor(
    private readonly turnRunning: () => boolean,
    private readonly jobCount: () => number,
    private readonly tell: (on: boolean) => void,
  ) {}

  /** Called about once a second. It says when the answer changes, and repeats "on" every heartbeat. */
  tick(now = Date.now()): void {
    if (now - this.scannedAt >= SCAN_MS) { this.jobs = this.jobCount(); this.scannedAt = now; }
    const on = this.turnRunning() || this.jobs > 0;
    if (on === this.on && !(on && now - this.sentAt >= HEARTBEAT_MS)) return;
    this.on = on;
    this.sentAt = now;
    this.tell(on);
  }
}
