/**
 * One long-lived Claude Code process, text in and text out (spec 7.2).
 *
 * The process stays alive for the whole conversation (3.3) and never sees
 * audio. The supervisor drives it: this file only owns the pipes, the turn
 * numbers (14.5) and the restart.
 */
import { appendFileSync, readFileSync } from "node:fs";
import type { Subprocess } from "bun";
import type { Config } from "./config.ts";
import { Narrator } from "./narrator.ts";
import { contextTokens, linesOf, parseLine, type Event, type Usage } from "./protocol.ts";
import { Supervisor, type Action } from "./supervisor.ts";

export interface Turn {
  /** 14.5 a number per turn, so a recovery command is not ambiguous */
  number: number;
  text: string;
  costUsd: number;
  isError: boolean;
}

/** 8.7.1 the resident size of the process, in bytes; null when it is gone. */
export function processRssBytes(pid: number): number | null {
  let status: string;
  try { status = readFileSync(`/proc/${pid}/status`, "utf8"); } catch { return null; }
  const match = /^VmRSS:\s+(\d+) kB$/m.exec(status);
  return match ? Number(match[1]) * 1024 : null;
}

/** 10.7 what the agent asks to run, and the id its answer must carry. */
export interface Permission {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface SessionHooks {
  /** 8.6.3 the bridge speaks at the checkpoint and waits for the agreement word */
  onCheckpoint?(runningMs: number): void;
  /** 5.5 the reply word by word; 7.3 collects it to a sentence and speaks it */
  onDelta?(text: string): void;
  /** 14.9 a block of the reply begins, and what it holds; the conversation tells the client of a text block */
  onBlockStart?(type: string): void;
  onBlockEnd?(): void;
  /** 2.3 what the bridge says while a tool runs, so a long turn is not silence */
  onNarration?(text: string): void;
  onRestart?(reason: string): void;
  onInterrupt?(reason: string): void;
  /**
   * 11.11 a turn nobody asked for. Claude Code answers a task notification on
   * its own, so a background job that finishes speaks without being spoken to.
   * The bridge used to drop every word of it: `onDelta` writes to a sink that
   * only exists for the length of a turn the bridge started.
   */
  onUnprompted?(turn: Turn): void;
  /**
   * 10.7 the agent asks before a tool runs, and waits for `answer`. It asks
   * only about what the ask rules of `src/gated.ts` name.
   */
  onPermission?(request: Permission): void;
  /** 10.7 a request that can no longer be answered: the process took it back, or it ended */
  onPermissionCancel?(id: string): void;
  /** 15.2 something to play while a turn is long */
  onEvent?(event: Event): void;
  /**
   * Item 4 the first message the agent began after the last `inject`. The
   * words before it belong to the answer Chris spoke over; these answer him.
   */
  onInjectedReply?(): void;
}

const TICK_MS = 1_000;

/**
 * The process, as the session needs it: what it prints, one line at a time,
 * what it is told, and when it ends. This is the seam the session is tested
 * across. `spawnClaude` is the process; a test gives a scripted one, or a file
 * of lines a real run printed, so the pump and everything above it run with
 * no Claude Code anywhere near them.
 */
export interface Process {
  /** for 8.7, which samples the memory; a process with no pid is not sampled */
  readonly pid: number | undefined;
  readonly lines: AsyncIterable<string>;
  write(line: string): void;
  kill(): void;
  readonly exited: Promise<unknown>;
}

export type Spawn = (config: Config, dir: string) => Process;

/** The real thing: Claude Code, in the project directory, on stream-json both ways. */
export const spawnClaude: Spawn = (config, dir) => {
  const child = Bun.spawn([config.claudeBin, ...config.claudeArgs, "--model", config.model], {
    cwd: dir,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  }) as Subprocess<"pipe", "pipe", "pipe">;
  return {
    pid: child.pid,
    lines: linesOf(child.stdout as ReadableStream<Uint8Array>),
    write(line) {
      try { child.stdin.write(`${line}\n`); child.stdin.flush(); } catch { /* the restart will notice */ }
    },
    kill() {
      try { child.kill(); } catch { /* already gone */ }
    },
    exited: child.exited,
  };
};

/**
 * The same process, with every line it prints appended to `path` as well, so
 * a real run becomes a fixture a test can replay through `Session`.
 */
export function recorded(spawn: Spawn, path: string): Spawn {
  return (config, dir) => {
    const inner = spawn(config, dir);
    async function* tee(): AsyncGenerator<string> {
      for await (const line of inner.lines) { appendFileSync(path, `${line}\n`); yield line; }
    }
    return { ...inner, lines: tee() };
  };
}

export class Session {
  private child: Process | null = null;
  private alive = false;
  private supervisor: Supervisor;
  private narrator: Narrator;
  private turnNumber = 0;
  private pending: { resolve(turn: Turn): void; reject(error: Error): void } | null = null;
  private replyText = "";
  private costUsd = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Item 4 what Chris said mid-turn was written into the turn, and whether a
   * message has begun since. A result that comes before one is the end of
   * the answer he spoke over, not of the turn.
   */
  private injection: { replied: boolean } | null = null;
  /** 10.7 the requests the current process waits on, by id, with the input an allow hands back */
  private asked = new Map<string, Record<string, unknown>>();
  /** 8.9 the window and the compaction threshold, once claude reports them */
  contextWindow = 0;
  contextThreshold = 0;
  contextUsed = 0;
  rateLimit: { fiveHour: number; sevenDay: number } = { fiveHour: 0, sevenDay: 0 };

  constructor(
    private readonly dir: string,
    private readonly config: Config,
    private readonly hooks: SessionHooks = {},
    private readonly spawn: Spawn = spawnClaude,
  ) {
    this.supervisor = new Supervisor(config);
    this.narrator = new Narrator(config);
  }

  start(): void {
    if (this.child) return;
    this.child = this.spawn(this.config, this.dir);
    // Bun does not fill in exitCode unless something awaits exited, so a child
    // that died still reads as running. Watch the exit instead, and check the
    // identity before recording it: a killed child's promise resolves after
    // its successor has already started.
    const started = this.child;
    this.alive = true;
    void started.exited.then(() => { if (this.child === started) this.alive = false; });
    void this.pump(this.child);
    this.timer = setInterval(() => this.tick(Date.now()), TICK_MS);
  }

  /**
   * A restart leaves this loop draining the stream of the process it killed.
   * That loop must not speak for the process that replaced it, so every step
   * checks that the child it reads is still the current one: without the check
   * the dying process rejects the first turn of its successor.
   */
  private async pump(child: Process): Promise<void> {
    for await (const line of child.lines) {
      if (this.child !== child) return;
      for (const event of parseLine(line)) this.handle(event, Date.now());
    }
    if (this.child !== child) return;
    this.cancelAsked();
    // the stream ended: either we killed it, or it died and the silence timer is about to say so
    if (this.pending) this.fail(new Error("the Claude Code process ended mid-turn"));
  }

  private handle(event: Event, now: number): void {
    this.supervisor.activity(now);
    this.hooks.onEvent?.(event);
    switch (event.kind) {
      case "toolStart": this.supervisor.toolStarted(event.id, now); this.narrator.started(event.id, event.tool, event.parentId, now); break;
      case "toolEnd": this.supervisor.toolEnded(event.id, now); this.narrator.ended(event.id); break;
      case "compaction": this.supervisor.compacted(now); break;
      case "text": this.replyText += event.text; break;
      case "delta": this.hooks.onDelta?.(event.text); break;
      case "blockStart": this.hooks.onBlockStart?.(event.type); break;
      case "blockEnd": this.hooks.onBlockEnd?.(); break;
      case "messageStart":
        if (this.injection && !this.injection.replied) { this.injection.replied = true; this.hooks.onInjectedReply?.(); }
        break;
      // 8.6.5 the receipt says the process took the interrupt. It does not say the
      // process is ready, so 8.6.7 still measures readiness by the grace time.
      case "permission": this.asked.set(event.id, event.input); this.hooks.onPermission?.({ id: event.id, tool: event.tool, input: event.input }); break;
      case "permissionCancel": if (this.asked.delete(event.id)) this.hooks.onPermissionCancel?.(event.id); break;
      case "controlResponse": this.hooks.onInterrupt?.(event.ok ? "the process took the interrupt" : "the process refused the interrupt"); break;
      case "context": this.contextWindow = event.window; this.contextThreshold = event.threshold; break;
      case "rateLimit": this.rateLimit = { fiveHour: event.fiveHour, sevenDay: event.sevenDay }; break;
      case "result": this.finish(event.text, event.costUsd, event.usage, event.isError, now); break;
      default: break;
    }
  }

  private finish(text: string, costUsd: number, usage: Usage, isError: boolean, now: number): void {
    this.costUsd += costUsd;
    this.contextUsed = contextTokens(usage);
    // Item 4, measured 24 September: a message written while the agent writes
    // its last text does not cut in. That answer ends with a result of its
    // own, and the message then runs as a second turn with a second result.
    // The first ends nothing: the turn, its ceiling and its silence timer go on.
    if (this.injection && !this.injection.replied) { this.replyText = ""; return; }
    this.injection = null;
    this.supervisor.turnEnded(now);
    this.narrator.turnEnded();
    const turn: Turn = { number: this.turnNumber, text: text || this.replyText.trim(), costUsd, isError };
    this.replyText = "";
    const pending = this.pending;
    this.pending = null;
    if (!pending) { this.hooks.onUnprompted?.(turn); return; }
    pending.resolve(turn);
  }

  private fail(error: Error): void {
    const pending = this.pending;
    this.pending = null;
    this.injection = null;
    pending?.reject(error);
  }

  /** 8.6 the ladder, once a second. 8.7 samples the process memory on the same tick. */
  private tick(now: number): void {
    const pid = this.child?.pid;
    if (pid !== undefined) {
      const rss = processRssBytes(pid);
      if (rss !== null) this.supervisor.memorySample(rss);
    }
    for (const phrase of this.narrator.due(now)) this.hooks.onNarration?.(phrase);
    const action: Action = this.supervisor.evaluate(now);
    switch (action.kind) {
      case "checkpoint":
        this.hooks.onCheckpoint?.(action.runningMs);
        break;
      case "interrupt":
        this.hooks.onInterrupt?.(action.reason);
        this.interrupt(now);
        break;
      case "restart":
        this.hooks.onRestart?.(action.reason);
        this.restart(action.reason);
        break;
      default:
        break;
    }
  }

  /** 8.6.4 the agreement word buys another ceiling. */
  agree(now = Date.now()): void {
    this.supervisor.agreed(now);
  }

  /**
   * 8.6.5 stop the turn, keep the process. Claude Code takes an interrupt on
   * its input stream; if it does not, 8.6.7 restarts after the grace time.
   */
  interrupt(now = Date.now()): void {
    this.supervisor.interruptSent(now);
    this.write({ type: "control_request", request: { subtype: "interrupt" } });
  }

  /**
   * 10.7 the answer to a permission request. Only a request the current
   * process still waits on is answered, and only once: a restart or a cancel
   * has already taken it back.
   */
  answer(id: string, allow: boolean, message = ""): void {
    const input = this.asked.get(id);
    if (!input) return;
    this.asked.delete(id);
    const response = allow ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message };
    this.write({ type: "control_response", response: { subtype: "success", request_id: id, response } });
  }

  /** 10.5 a process that ends takes its requests with it, and whoever asked Chris is told. */
  private cancelAsked(): void {
    const ids = [...this.asked.keys()];
    this.asked.clear();
    for (const id of ids) this.hooks.onPermissionCancel?.(id);
  }

  restart(reason: string): void {
    this.stop();
    this.fail(new Error(`restarted: ${reason}`));
    this.start();
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.cancelAsked();
    this.child?.kill();
    this.child = null;
  }

  private write(value: unknown): void {
    this.child?.write(JSON.stringify(value));
  }

  /**
   * Item 4 what Chris said, written into the turn that runs, with no
   * interrupt. Measured 24 September: sent while a tool runs, the process
   * reads it when the tool returns and the agent answers it in the same turn,
   * with one result. False when no turn runs: the result is already back.
   */
  inject(text: string): boolean {
    if (!this.pending) return false;
    this.injection = { replied: false };
    this.write({ type: "user", message: { role: "user", content: text } });
    return true;
  }

  /** One turn: text in, text out. Claude Code never sees audio (3.3). */
  ask(text: string): Promise<Turn> {
    if (!this.child) this.start();
    if (this.pending) return Promise.reject(new Error("a turn is already running"));
    this.turnNumber += 1;
    this.replyText = "";
    this.supervisor.turnStarted(Date.now());
    this.write({ type: "user", message: { role: "user", content: text } });
    return new Promise<Turn>((resolve, reject) => { this.pending = { resolve, reject }; });
  }

  /**
   * Whether the agent is actually there, for the health check. Holding a
   * child object is not the same as having a process: kill claude from
   * outside and this stayed true through two attempts at writing it, first
   * on child !== null and then on exitCode. A health check that cannot see
   * the failure it exists for is worse than none.
   */
  get running(): boolean { return this.child !== null && this.alive; }

  /** How many turns this process has taken. */
  get turns(): number { return this.turnNumber; }

  /** 8.9 how close the context is to a compaction, now that claude reports both numbers. */
  contextFraction(): number | null {
    if (!this.contextThreshold) return null;
    return this.contextUsed / this.contextThreshold;
  }

  totalCostUsd(): number {
    return this.costUsd;
  }
}
