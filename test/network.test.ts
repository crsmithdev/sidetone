import { describe, expect, test } from "bun:test";
import { Network, qualityOf } from "../src/network.ts";

describe("what the framework reports (N.1)", () => {
  test("the node SDK counts and the browser SDK spells", () => {
    expect(qualityOf(0)).toBe("poor");
    expect(qualityOf(1)).toBe("good");
    expect(qualityOf(2)).toBe("excellent");
    expect(qualityOf(3)).toBe("lost");
    expect(qualityOf("Excellent")).toBe("excellent");
    expect(qualityOf("poor")).toBe("poor");
    expect(qualityOf(undefined)).toBe("unknown");
    expect(qualityOf(99)).toBe("unknown");
  });
});

describe("the connection, kept (N.2)", () => {
  test("nothing reported says so rather than guessing", () => {
    expect(new Network().report()).toBe("Nothing has reported on the connection yet.");
  });

  test("only a change is a change, which is what a cue would need (N.2.4)", () => {
    const net = new Network();
    expect(net.saw("phone", "good", 1_000)).toBe(true);
    expect(net.saw("phone", "good", 2_000)).toBe(false);
    expect(net.saw("phone", "poor", 3_000)).toBe(true);
    expect(net.changeCount).toBe(2);
  });

  test("the worse of the two ends is the one Chris is living with", () => {
    const net = new Network();
    net.saw("bridge", "excellent", 1_000);
    net.saw("phone", "poor", 1_000);
    expect(net.worst()).toBe("poor");
    net.saw("phone", "excellent", 2_000);
    expect(net.worst()).toBe("excellent");
  });

  test("time at a level counts the stretch that has not ended yet", () => {
    const net = new Network();
    net.saw("phone", "poor", 1_000);
    expect(net.spentAt("phone", "poor", 4_000)).toBe(3_000);
    net.saw("phone", "good", 4_000);
    expect(net.spentAt("phone", "poor", 9_000)).toBe(3_000);
  });

  test("the report adds up the rough stretches, and stays quiet about a blip", () => {
    const net = new Network();
    net.saw("phone", "poor", 0);
    net.saw("bridge", "good", 0);
    net.saw("phone", "good", 12_000);
    expect(net.report(12_000)).toBe(
      "The phone's connection is good and this end is good. The phone has been poor or lost for 12 seconds of this session.",
    );
    const blip = new Network();
    blip.saw("phone", "poor", 0);
    blip.saw("phone", "good", 400);
    expect(blip.report(400)).toBe("The phone's connection is good and this end is not reported yet.");
  });
});
