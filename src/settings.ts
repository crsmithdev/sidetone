/**
 * The settings in force, and the one way to change one (spec 9.4, 9.4.9,
 * item 44).
 *
 * A setting used to have four live copies: the config, private fields in the
 * conversation, the ear's options and the mouth's. A change reached each by
 * hand, and item 44 was a threshold that reached the file and not the ear.
 * The values live in one object now, and this is its only writer. The
 * conversation, the ear, the mouth and the channel read it on each look.
 *
 * One change is checked by the rules the file is checked by, then taken,
 * kept for the next run, recorded, and sent to every client. A refused change
 * is none of those: every client is sent the settings in force again, so a
 * control that moved under the finger goes back.
 */
import { checkConfig, type Config } from "./config.ts";

/** Where a change goes once it is taken. */
export interface SettingsEnds {
  /** 9.4 the file the next run reads */
  keep(patch: Partial<Config>): void;
  /** 18 the record says when a setting changed */
  record(patch: Partial<Config>): void;
  /** 9.4.9 every client is told what is in force now */
  broadcast(): void;
  /** the journal, which says why a change was refused */
  journal(line: string): void;
}

export class Settings {
  constructor(
    /** the values in force, which /diagnostics and the health line also read */
    readonly values: Readonly<Config>,
    private readonly ends: SettingsEnds,
  ) {}

  /**
   * One change, however it arrived. Item 44 a value the bridge takes live is
   * written to the file, and a start that refused it would look like the
   * bridge is broken, so it is checked by `checkConfig`. False when refused.
   */
  change(patch: Partial<Config>): boolean {
    try {
      checkConfig({ ...this.values, ...patch });
    } catch (error) {
      const what = Object.entries(patch).map(([key, value]) => `${key} ${String(value)}`).join(", ");
      this.ends.journal(`refused ${what}: ${(error as Error).message}`);
      this.ends.broadcast();
      return false;
    }
    Object.assign(this.values, patch);
    this.ends.keep(patch);
    this.ends.record(patch);
    this.ends.broadcast();
    return true;
  }
}
