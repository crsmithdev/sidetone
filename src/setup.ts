/**
 * The phone's audio setup, pushed from the bridge (spec 18.15).
 *
 * On 23 September one boolean, the echo canceller, cost three app builds and
 * two hours, and each try had to be driven. Every echo experiment from here
 * changes the setup and measures it in a car, so the setup changes from the
 * bridge, and the record always says which one ran (14.15). This reads a
 * setup from its names and says it the way the journal does; the app maps the
 * names to Android's constants (4.2.2).
 */
import type { AudioSetup, Setup } from "./messages.ts";

const MODES = ["call", "normal"] as const;
const OUTPUTS = ["voice", "media"] as const;
const FOCUSES = ["gain", "none"] as const;
const CANCELLERS = ["hardware", "software"] as const;

/**
 * A setup from a request body or a device message, or null when a name is
 * not one the app maps. A `default` of true reads nothing else: the phone
 * goes back to the setup in its code, and a stale name cannot ride along.
 */
export function readSetup(value: Record<string, unknown>): Setup | null {
  if (value.default === true) return { kind: "setup", default: true };
  const names = readNames(value);
  return names ? { kind: "setup", default: false, ...names } : null;
}

/** The six names alone, or null when one is missing or not one the app maps. */
export function readNames(value: Record<string, unknown>): AudioSetup | null {
  const { mode, output, focus, canceller, noiseSuppression, autoGainControl } = value;
  if (!one(MODES, mode) || !one(OUTPUTS, output) || !one(FOCUSES, focus) || !one(CANCELLERS, canceller)) return null;
  if (typeof noiseSuppression !== "boolean" || typeof autoGainControl !== "boolean") return null;
  return { mode, output, focus, canceller, noiseSuppression, autoGainControl };
}

/** The setup as the journal says it. */
export function setupWords(setup: Setup): string {
  return setup.default ? "the setup in the app's code" : namesWords(setup);
}

/** The six names as the journal says them. */
export function namesWords(names: AudioSetup): string {
  return [
    `${names.mode} mode`,
    `${names.output} output`,
    names.focus === "none" ? "no focus" : `${names.focus} focus`,
    `${names.canceller} canceller`,
    `noise suppression ${names.noiseSuppression ? "on" : "off"}`,
    `auto gain control ${names.autoGainControl ? "on" : "off"}`,
  ].join(", ");
}

function one<T extends string>(of: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (of as readonly string[]).includes(value);
}
