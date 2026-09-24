/**
 * What the phone says about itself when the bridge greets it (spec 14.15).
 *
 * On 23 September the bridge heard its own voice, and the record could not say
 * which echo canceller had run, on which phone, over which audio route, or
 * even which of three builds of the app was in the room. The app says all of
 * that once for each greeting, and this reads it.
 */
import type { Device } from "./diagnostics.ts";
import { namesWords, readNames } from "./setup.ts";

/**
 * The phone's message, read. `served` is the hash of the app the bridge
 * serves now, or undefined when none is built. It returns the event for the
 * record, or null for a message that is not readable, and the journal line.
 */
export function readDevice(value: Record<string, unknown>, served: string | undefined, at = Date.now()): { event: Device | null; line: string } {
  const { model, aec, canceller, route, apk, setup, pushed } = value;
  const unreadable = { event: null, line: "a device message from the phone was not readable" };
  if (typeof model !== "string" || typeof aec !== "boolean" || (canceller !== "hardware" && canceller !== "software")
    || typeof route !== "string" || (apk !== undefined && typeof apk !== "string")) {
    return unreadable;
  }
  // 18.15 an app from before the setup message names none; one that names it says whether the bridge pushed it
  const names = setup === undefined ? undefined : readNames(setup as Record<string, unknown>);
  if (setup !== undefined && (names === null || typeof pushed !== "boolean")) return unreadable;
  const same = apk === undefined || served === undefined ? null : apk.toLowerCase() === served.toLowerCase();
  const event: Device = {
    kind: "device", at, model, aec, canceller, route, ...(apk === undefined ? {} : { apk }), same,
    ...(names ? { setup: names, pushed: pushed as boolean } : {}),
  };
  const ran = names ? `, setup ${namesWords(names)}, ${pushed ? "pushed" : "the one in the code"}` : "";
  return { event, line: `the phone is a ${model}: ${canceller} echo canceller (hardware ${aec ? "available" : "not available"}), route ${route}, ${build(apk, served, same)}${ran}` };
}

/** 14.15.2 the app's build, and whether it is the one the bridge serves now. */
function build(apk: string | undefined, served: string | undefined, same: boolean | null): string {
  if (apk === undefined) return "build unknown";
  const short = apk.slice(0, 12);
  if (served === undefined) return `build ${short}; the bridge serves no build`;
  return same ? `build ${short}, the build the bridge serves` : `build ${short}, not the build the bridge serves (${served.slice(0, 12)})`;
}
