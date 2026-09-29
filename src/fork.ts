/**
 * Item 55 a slow session, and the fork that leaves it (spec 8.13).
 *
 * The server keys a delay of about 1.2 s to the session id: measured 28
 * September, a slow session stayed slow under its own id, and a fork of the
 * same transcript under a new id was fast. The fork has the same context and
 * reads the same cache. So the bridge times the first requests of each
 * session, and when each of them was slow it asks for a fork between turns.
 *
 * This file only watches and decides. `Session` makes the fork.
 */
import type { Config } from "./config.ts";
import type { Event } from "./protocol.ts";

/**
 * 8.13.3 the forks in a row, after which the lineage is left as it is. A fork
 * that is slow as well is forked once more, not again and again.
 */
export const FORKS_IN_A_ROW = 2;

/** 8.13 the session to fork, and the times that made it slow. */
export interface Slow {
  from: string;
  requestMs: number[];
}

/** 8.13.4 the one line a fork writes to the log */
export function forkLine(from: string, to: string, requestMs: number[]): string {
  return `the agent's session ${from} was slow, ${requestMs.map((ms) => (ms / 1000).toFixed(2)).join(", ")} s to its first messages: forked it as ${to}`;
}

export class SlowWatch {
  /** the session the times belong to */
  private id = "";
  private requestMs: number[] = [];
  private requestedAt = 0;
  /** the times are in, or the lineage is done: nothing more is timed */
  private done = false;
  private due = false;
  /** the forks since the process last started with no fork */
  private forks = 0;

  constructor(private readonly config: Pick<Config, "forkSlowMs" | "forkAfterRequests">) {}

  /** A process that is no fork: a new session, and a new lineage. */
  reset(): void {
    this.id = "";
    this.forks = 0;
    this.watch();
  }

  private watch(): void {
    this.requestMs = [];
    this.requestedAt = 0;
    this.done = this.forks >= FORKS_IN_A_ROW;
    this.due = false;
  }

  event(event: Event, now: number): void {
    if (event.kind === "init") {
      if (event.sessionId === this.id) return;
      this.id = event.sessionId;
      this.watch();
      return;
    }
    if (this.done || !this.id) return;
    if (event.kind === "requesting") { this.requestedAt = now; return; }
    if (event.kind !== "messageStart" || !this.requestedAt) return;
    // 18.4.1 `requestMs`: the request left, to its first message began
    this.requestMs.push(now - this.requestedAt);
    this.requestedAt = 0;
    if (this.requestMs.length < this.config.forkAfterRequests) return;
    this.done = true;
    this.due = this.requestMs.every((ms) => ms > this.config.forkSlowMs);
  }

  /** The fork to make now, once; null when the session is fast or not yet timed. */
  take(): Slow | null {
    if (!this.due) return null;
    this.due = false;
    this.forks += 1;
    return { from: this.id, requestMs: this.requestMs };
  }
}
