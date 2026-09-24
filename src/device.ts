/**
 * What the phone says about itself when it joins the room (spec 14.15).
 *
 * On 23 September the bridge heard its own voice, and the record could not say
 * which echo canceller had run, on which phone, over which audio route, or
 * even which of three builds of the app was in the room. The app says all of
 * that once for each room, and this reads it.
 */
import type { Device } from "./diagnostics.ts";

/**
 * The phone's message, read. `served` is the hash of the app the bridge
 * serves now, or undefined when none is built. It returns the event for the
 * record, or null for a message that is not readable, and the journal line.
 */
export function readDevice(value: Record<string, unknown>, served: string | undefined, at = Date.now()): { event: Device | null; line: string } {
  const { model, aec, canceller, route, apk } = value;
  if (typeof model !== "string" || typeof aec !== "boolean" || (canceller !== "hardware" && canceller !== "software")
    || typeof route !== "string" || (apk !== undefined && typeof apk !== "string")) {
    return { event: null, line: "a device message from the phone was not readable" };
  }
  const same = apk === undefined || served === undefined ? null : apk.toLowerCase() === served.toLowerCase();
  const event: Device = { kind: "device", at, model, aec, canceller, route, ...(apk === undefined ? {} : { apk }), same };
  return { event, line: `the phone is a ${model}: ${canceller} echo canceller (hardware ${aec ? "available" : "not available"}), route ${route}, ${build(apk, served, same)}` };
}

/** 14.15.2 the app's build, and whether it is the one the bridge serves now. */
function build(apk: string | undefined, served: string | undefined, same: boolean | null): string {
  if (apk === undefined) return "build unknown";
  const short = apk.slice(0, 12);
  if (served === undefined) return `build ${short}; the bridge serves no build`;
  return same ? `build ${short}, the build the bridge serves` : `build ${short}, not the build the bridge serves (${served.slice(0, 12)})`;
}
