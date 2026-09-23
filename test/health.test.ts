import { describe, expect, test } from "bun:test";
import { wellEnough } from "../src/serve.ts";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

describe("what the health probe calls well (11.13)", () => {
  test("a warm bridge in the room is well", () => {
    expect(wellEnough(true, true, true, 10 * MINUTE)).toBe(true);
  });

  /**
   * 23 September 2026: the probe runs every two minutes and chatterbox takes
   * about 160 seconds to load, so every probe failed, every failure restarted
   * the bridge, and the engines never finished. The bridge was in a restart
   * loop for eleven minutes.
   */
  test("an engine still loading is not a fault", () => {
    expect(wellEnough(true, true, false, 8 * SECOND)).toBe(true);
    expect(wellEnough(true, true, false, 3 * MINUTE)).toBe(true);
  });

  test("an engine that never loads is a fault, so a stuck bridge is still recovered", () => {
    expect(wellEnough(true, true, false, 11 * MINUTE)).toBe(false);
  });

  test("no room and no agent are faults whatever the engines are doing", () => {
    expect(wellEnough(false, true, true, 10 * MINUTE)).toBe(false);
    expect(wellEnough(true, false, true, 10 * MINUTE)).toBe(false);
    // and the warm-up does not excuse them
    expect(wellEnough(false, true, false, 8 * SECOND)).toBe(false);
  });

  /** The allowance has to clear the real load time, or it buys nothing. */
  test("the allowance is longer than the load it covers", () => {
    // chatterbox loaded in 146 s on a quiet machine and 240 s on a busy one,
    // both measured 23 September 2026
    expect(wellEnough(true, true, false, 146 * SECOND)).toBe(true);
    expect(wellEnough(true, true, false, 240 * SECOND)).toBe(true);
    expect(wellEnough(true, true, false, 6 * MINUTE)).toBe(true);
  });
});
