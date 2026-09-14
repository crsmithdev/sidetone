import { describe, expect, test } from "bun:test";
import { mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { livekitConfig, loadOrCreateKeys } from "../src/keys.ts";

const where = () => join(mkdtempSync(join(tmpdir(), "keys-")), "keys.json");

describe("the api keys (12.1)", () => {
  test("a missing file is made, and the second call gets the same pair", () => {
    const path = where();
    const first = loadOrCreateKeys(path);
    expect(first.apiKey).toBeTruthy();
    expect(first.apiSecret).toBeTruthy();
    // a fresh pair on every start would lock out the phone that paired yesterday
    expect(loadOrCreateKeys(path)).toEqual(first);
  });

  test("the secret is not left readable by anyone else", () => {
    const path = where();
    loadOrCreateKeys(path);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test("the pair is long enough to be worth signing with", () => {
    const keys = loadOrCreateKeys(where());
    expect(keys.apiSecret.length).toBeGreaterThanOrEqual(32);
    expect(keys.apiKey).not.toBe("devkey");
  });
});

describe("the server config the bridge writes (12.1)", () => {
  const written = livekitConfig({ apiKey: "anapikey", apiSecret: "asecret" }, "100.68.96.43", 7880);

  test("it carries the same pair the bridge holds, so the two cannot drift", () => {
    expect(written).toContain("anapikey");
    expect(written).toContain("asecret");
  });

  test("it advertises the address a phone can reach, not the loopback", () => {
    expect(written).toContain("100.68.96.43");
    expect(written).not.toContain("127.0.0.1");
  });

  test("it is the port the bridge tells the phone about", () => {
    expect(written).toContain("7880");
  });
});
