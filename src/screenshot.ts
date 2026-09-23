/**
 * The screenshot, on disk (spec 14.12).
 *
 * Chris takes a screenshot on the phone while the app is on the screen, and
 * the app sends the image here. The agent cannot see a phone, so this writes
 * the image to a file the agent reads. One data message is small, so one image
 * arrives in parts of base64, and this keeps them until it has all of them.
 *
 * One file holds one screenshot, which the `id` names. `latest.jpg` points at
 * the file written last.
 *
 * Item 38 a written screenshot is pending until the next turn takes it. The
 * turn names the file to the agent. A pending screenshot expires after
 * `PENDING_MS`, and Chris can drop one from the app. Each change goes to the
 * client, which shows the mark on the thumbnail.
 */
import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Outgoing } from "./messages.ts";

export const SCREENSHOT_DIR = join(homedir(), ".sidetone", "screenshots");

/** The id becomes a file name, so it is one plain word. */
const ID = /^[A-Za-z0-9-]{1,64}$/;

/** 14.12.1 more parts than this is not a screenshot of a phone. */
const MAX_PARTS = 200;

/** 14.12.6 how long a written screenshot waits for a turn. An older one must not join an unrelated turn. */
export const PENDING_MS = 120_000;

type Told = Extract<Outgoing, { kind: "screenshot" }>;

export class Screenshots {
  /** The image that arrives now. A part of a different image drops it. */
  private pending: { id: string; of: number; parts: string[] } | null = null;

  /** 14.12.6 the screenshots written and not yet taken by a turn, oldest first. */
  private waiting: Array<{ id: string; file: string; at: number }> = [];

  constructor(
    private readonly dir = SCREENSHOT_DIR,
    /** 14.12.7 what the client is told of a pending screenshot */
    private readonly tell: (message: Told) => void = () => {},
  ) {}

  /**
   * One part of a screenshot, or 14.12.7 a request to drop a pending one. It
   * returns the lines for the journal: where an image goes, or what went wrong.
   */
  receive(value: Record<string, unknown>, now = Date.now()): string[] {
    if (value.drop === true) return this.drop(value.id);
    const { id, part, of, data } = value;
    if (
      typeof id !== "string" || !ID.test(id) || typeof data !== "string" ||
      !Number.isInteger(of) || !Number.isInteger(part) ||
      (of as number) < 1 || (of as number) > MAX_PARTS || (part as number) < 1 || (part as number) > (of as number)
    ) {
      return ["a part of a screenshot from the phone was not readable"];
    }
    const said: string[] = [];
    if (this.pending && (this.pending.id !== id || this.pending.of !== of)) {
      said.push(`the screenshot ${this.pending.id} from the phone was not whole, and is dropped`);
      this.pending = null;
    }
    this.pending ??= { id, of: of as number, parts: [] };
    this.pending.parts[(part as number) - 1] = data;
    const { parts } = this.pending;
    if (parts.filter((p) => p !== undefined).length < this.pending.of) return said;
    this.pending = null;
    const file = join(this.dir, `${id}.jpg`);
    try {
      mkdirSync(this.dir, { recursive: true });
      writeFileSync(file, Buffer.from(parts.join(""), "base64"));
      const latest = join(this.dir, "latest.jpg");
      rmSync(latest, { force: true });
      symlinkSync(`${id}.jpg`, latest);
    } catch (error) {
      return [...said, `the screenshot was not written: ${(error as Error).message}`];
    }
    this.waiting.push({ id, file, at: now });
    this.tell({ kind: "screenshot", id, state: "pending" });
    return [...said, `screenshot at ${file}`];
  }

  /** 14.12.6 the files of the pending screenshots, in the order they arrived. The turn that asks takes them all. */
  take(now = Date.now()): string[] {
    this.expire(now);
    const taken = this.waiting;
    this.waiting = [];
    for (const { id } of taken) this.tell({ kind: "screenshot", id, state: "sent" });
    return taken.map(({ file }) => file);
  }

  /** 14.12.6 a pending screenshot older than `PENDING_MS` goes. It returns the lines for the journal. */
  expire(now = Date.now()): string[] {
    const old = this.waiting.filter(({ at }) => now - at >= PENDING_MS);
    if (old.length === 0) return [];
    this.waiting = this.waiting.filter((shot) => !old.includes(shot));
    for (const { id } of old) this.tell({ kind: "screenshot", id, state: "expired" });
    return old.map(({ id }) => `the screenshot ${id} expired before Chris said anything`);
  }

  private drop(id: unknown): string[] {
    const shot = this.waiting.find((waiting) => waiting.id === id);
    if (!shot) return [];
    this.waiting = this.waiting.filter((waiting) => waiting !== shot);
    this.tell({ kind: "screenshot", id: shot.id, state: "dropped" });
    return [`Chris dropped the screenshot ${shot.id}`];
  }
}
