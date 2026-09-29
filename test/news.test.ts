/** Item 76 the notifications level on a line of job news (14.10.6). */
import { describe, expect, test } from "bun:test";
import { BRIEF_NEWS_LINE, briefLine, newsTurn } from "../src/news.ts";

describe("the notifications level (item 76)", () => {
  const lines = ["sidetone/alpha passed", "cloudchamber/beta needs-you which branch?", "sidetone/gamma landed; check open; a note"];

  test("full passes each line as aleph sent it", () => {
    expect(newsTurn(lines, "full")).toBe(lines.map((line) => `[job news] ${line}`).join("\n"));
  });

  test("brief passes only a start, an end or a failure, and tells the agent to say only that", () => {
    expect(newsTurn(lines, "brief")).toBe(`${BRIEF_NEWS_LINE}\n\n[job news] sidetone/alpha finished\n[job news] sidetone/gamma finished`);
  });

  test("off passes nothing", () => {
    expect(newsTurn(lines, "off")).toBeNull();
  });

  test("brief leaves nothing to say when no line is a start, an end or a failure", () => {
    expect(newsTurn(["cloudchamber/beta needs-you which branch?", "sidetone/delta dropped"], "brief")).toBeNull();
  });

  test("brief cuts each state to started, finished or failed", () => {
    expect(briefLine("sidetone/alpha running")).toBe("sidetone/alpha started");
    expect(briefLine("sidetone/alpha done")).toBe("sidetone/alpha finished");
    expect(briefLine("sidetone/alpha failed bun test")).toBe("sidetone/alpha failed");
    // a plain command's news is `<name> finished|failed`
    expect(briefLine("build finished")).toBe("build finished");
    expect(briefLine("build failed")).toBe("build failed");
    expect(briefLine("sidetone/alpha needs-you why?")).toBeNull();
    expect(briefLine("sidetone/alpha")).toBeNull();
  });
});
