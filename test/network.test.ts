import { describe, expect, test } from "bun:test";
import { Network, qualityOf, receivedLine } from "../src/network.ts";

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

describe("what the phone received of the bridge's voice (item 56)", () => {
  test("one journal line gives the loss, the concealment, the stretch, the buffer and the codec", () => {
    expect(receivedLine({
      kind: "receive", ms: 5_012, packets: 250, lost: 3, samples: 240_000, concealed: 4_800, events: 2,
      inserted: 0, removed: 480, bufferMs: 62, codec: "audio/opus",
    })).toBe(
      "the phone received 5.0 s of the bridge's voice: 250 packets, 3 lost; 2.0% concealed in 2 events; " +
      "0.0% stretched, 0.2% squeezed; jitter buffer 62 ms; audio/opus",
    );
  });

  test("a reading with no samples and no codec still reads, and one with no time does not", () => {
    expect(receivedLine({ kind: "receive", ms: 800 })).toBe(
      "the phone received 0.8 s of the bridge's voice: 0 packets, 0 lost; 0.0% concealed in 0 events; " +
      "0.0% stretched, 0.0% squeezed; jitter buffer 0 ms; codec not reported",
    );
    expect(receivedLine({ kind: "receive" })).toBe("a receive reading from the phone was not readable");
  });
});
