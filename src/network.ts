/**
 * What the connection is doing (the network-quality addendum, N.1 and N.2).
 *
 * The bridge does not measure this. LiveKit already knows: WebRTC keeps the
 * round trip, the loss and the jitter, and the framework reduces them to four
 * levels that are easier to act on than the raw numbers.
 *
 * Both ends are kept, because they answer different questions. The bridge's
 * own reading says whether the machine is reaching the room. The phone's says
 * whether the car is, and in a car it is the phone's uplink that goes first.
 *
 * This is the whole of phase one: read it, keep it, say it. Nothing here acts
 * on the reading. What to do about a bad connection is a decision that wants a
 * drive behind it, and this is what makes that drive worth taking.
 */

export type Quality = "excellent" | "good" | "poor" | "lost" | "unknown";
export type Side = "phone" | "bridge";

/** The four the framework reports, worst first, so they can be compared. */
const RANK: Record<Quality, number> = { lost: 0, poor: 1, good: 2, excellent: 3, unknown: 4 };

/** LiveKit's node SDK reports a number; its browser SDK reports a string. */
export function qualityOf(value: unknown): Quality {
  if (typeof value === "string") {
    const name = value.toLowerCase();
    return name === "excellent" || name === "good" || name === "poor" || name === "lost" ? name : "unknown";
  }
  switch (value) {
    case 0: return "poor";
    case 1: return "good";
    case 2: return "excellent";
    case 3: return "lost";
    default: return "unknown";
  }
}

interface Held {
  quality: Quality;
  /** when this level started, so the time in it can be closed off */
  since: number;
  /** total milliseconds at each level, this session */
  spent: Record<Quality, number>;
}

export class Network {
  private readonly sides: Record<Side, Held> = {
    phone: blank(),
    bridge: blank(),
  };
  /** every change, newest last, for the log a drive leaves behind */
  private readonly changes: Array<{ side: Side; quality: Quality; at: number }> = [];

  /** A reading arrived. Returns true when it is a change, which is what a cue would want (N.2.4). */
  saw(side: Side, quality: Quality, now = Date.now()): boolean {
    const held = this.sides[side];
    if (held.quality === quality) return false;
    // guard on the level, not on `since`: a stretch that began at timestamp 0
    // is a real stretch, and testing the number treats it as one that never was
    if (held.quality !== "unknown") held.spent[held.quality] += now - held.since;
    held.quality = quality;
    held.since = now;
    this.changes.push({ side, quality, at: now });
    if (this.changes.length > 200) this.changes.shift();
    return true;
  }

  get(side: Side): Quality { return this.sides[side].quality; }

  /** The worse of the two ends, because that is the one Chris is living with. */
  worst(): Quality {
    const phone = this.sides.phone.quality;
    const bridge = this.sides.bridge.quality;
    return RANK[phone] <= RANK[bridge] ? phone : bridge;
  }

  /** Milliseconds at a level, this session, with the open stretch counted in. */
  spentAt(side: Side, quality: Quality, now = Date.now()): number {
    const held = this.sides[side];
    const open = held.quality === quality && held.quality !== "unknown" ? now - held.since : 0;
    return held.spent[quality] + open;
  }

  get changeCount(): number { return this.changes.length; }

  /** N.2.5 the connection, on demand and out loud. */
  report(now = Date.now()): string {
    if (this.sides.phone.quality === "unknown" && this.sides.bridge.quality === "unknown") {
      return "Nothing has reported on the connection yet.";
    }
    const parts = [`The phone's connection is ${say(this.sides.phone.quality)} and this end is ${say(this.sides.bridge.quality)}.`];
    const rough = this.spentAt("phone", "poor", now) + this.spentAt("phone", "lost", now);
    if (rough >= 1_000) {
      parts.push(`The phone has been poor or lost for ${Math.round(rough / 1000)} seconds of this session.`);
    }
    return parts.join(" ");
  }
}

function blank(): Held {
  return { quality: "unknown", since: 0, spent: { excellent: 0, good: 0, poor: 0, lost: 0, unknown: 0 } };
}

function say(quality: Quality): string {
  return quality === "unknown" ? "not reported yet" : quality;
}
