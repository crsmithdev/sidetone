import { describe, expect, test } from "bun:test";
import { LongMarker, SentenceCollector, withoutMarker } from "../src/sentences.ts";

describe("sentence collector (5.6)", () => {
  test("a sentence is ready as soon as its end is certain", () => {
    const c = new SentenceCollector(240);
    expect(c.push("The bridge is ready")).toEqual([]);
    // the full stop alone is not enough: the next character may make it a number
    expect(c.push(".")).toEqual([]);
    expect(c.push(" And")).toEqual(["The bridge is ready."]);
  });
  test("a decimal is not the end of a sentence", () => {
    const c = new SentenceCollector(240);
    expect(c.push("it costs 3.5 cents. ")).toEqual(["it costs 3.5 cents."]);
  });
  test("a newline ends a sentence, for a list", () => {
    const c = new SentenceCollector(240);
    expect(c.push("one\ntwo\n")).toEqual(["one", "two"]);
  });
  test("a closing quote stays with its sentence", () => {
    const c = new SentenceCollector(240);
    expect(c.push('he said "go." then left. ')).toEqual(['he said "go."', "then left."]);
  });
  test("a long run with no punctuation is broken at a space, so the audio is not held back", () => {
    const c = new SentenceCollector(20);
    expect(c.push("aaaa bbbb cccc dddd eeee ffff")).toEqual(["aaaa bbbb cccc dddd"]);
  });
  test("the tail of a reply is a sentence even without punctuation", () => {
    const c = new SentenceCollector(240);
    c.push("no full stop here");
    expect(c.flush()).toBe("no full stop here");
    expect(c.flush()).toBeNull();
  });
  test("a full stop at the end of the text waits, and the flush gives it back as a sentence (item 31)", () => {
    const c = new SentenceCollector(240);
    expect(c.push("I'll check the worktrees.")).toEqual([]);
    expect(c.flush()).toBe("I'll check the worktrees.");
  });
  test("a number or an ellipsis split across pushes is not split", () => {
    const c = new SentenceCollector(240);
    expect(c.push("it costs 3.")).toEqual([]);
    expect(c.push("5 cents. ")).toEqual(["it costs 3.5 cents."]);
    expect(c.push("well.")).toEqual([]);
    expect(c.push("..")).toEqual([]);
    expect(c.push(" maybe. ")).toEqual(["well...", "maybe."]);
  });
});

describe("the long marker (15.7.4)", () => {
  /** the words the deltas give, and whether the reply was long, once the reply ends */
  function run(deltas: string[]) {
    const marker = new LongMarker();
    let text = "";
    for (const delta of deltas) text += marker.push(delta);
    text += marker.end();
    return { text, long: marker.long };
  }

  test("the marker and the space after it are taken off the start", () => {
    expect(run(["[long] Checking the logs."])).toEqual({ text: "Checking the logs.", long: true });
  });
  test("the marker alone is a long reply with no words", () => {
    expect(run(["[long]"])).toEqual({ text: "", long: true });
  });
  test("a marker split at any point is still the marker", () => {
    const whole = "[long] Checking the logs.";
    for (let at = 1; at < whole.length; at++) {
      expect(run([whole.slice(0, at), whole.slice(at)])).toEqual({ text: "Checking the logs.", long: true });
    }
    expect(run([...whole])).toEqual({ text: "Checking the logs.", long: true });
  });
  test("the space after the marker can arrive in a delta of its own", () => {
    const marker = new LongMarker();
    expect(marker.push("[long]")).toBe("");
    expect(marker.push(" ")).toBe("");
    expect(marker.push("\nGo on.")).toBe("Go on.");
    expect(marker.push(" More.")).toBe(" More.");
  });
  test("a reply with no marker is not long, and comes out whole", () => {
    expect(run(["Checking the logs."])).toEqual({ text: "Checking the logs.", long: false });
  });
  test("the start of a reply that only looks like the marker comes out whole", () => {
    expect(run(["[lo", "gged in] is the state."])).toEqual({ text: "[logged in] is the state.", long: false });
    expect(run(["[", "1] is the first."])).toEqual({ text: "[1] is the first.", long: false });
  });
  test("a marker after the start is left in the text", () => {
    expect(run(["Checking. ", "[long] More."])).toEqual({ text: "Checking. [long] More.", long: false });
    expect(run(["Checking [long] the logs."])).toEqual({ text: "Checking [long] the logs.", long: false });
  });
  test("a marker with a word in front of it is not at the start", () => {
    expect(run([" [long] Checking."])).toEqual({ text: " [long] Checking.", long: false });
  });
  test("a start that ends the reply is given back", () => {
    const marker = new LongMarker();
    expect(marker.push("[lo")).toBe("");
    expect(marker.end()).toBe("[lo");
    expect(marker.long).toBe(false);
  });
  test("ending the start early, as a tool call does, stops the look for the marker", () => {
    const marker = new LongMarker();
    expect(marker.end()).toBe("");
    expect(marker.push("[long] Done.")).toBe("[long] Done.");
    expect(marker.long).toBe(false);
  });
  test("the finished text of a reply loses the marker the same way", () => {
    expect(withoutMarker("[long] Checking the logs.")).toBe("Checking the logs.");
    expect(withoutMarker("Checking. [long] More.")).toBe("Checking. [long] More.");
  });
  test("the collector never sees the marker", () => {
    const marker = new LongMarker();
    const c = new SentenceCollector(240);
    const said = ["[lo", "ng] Checking. ", "Done."].flatMap((delta) => c.push(marker.push(delta)));
    expect(said).toEqual(["Checking."]);
    expect(c.flush()).toBe("Done.");
  });
});
