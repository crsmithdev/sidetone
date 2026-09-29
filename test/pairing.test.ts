import { expect, test } from "bun:test";
import { pairingLink } from "../src/serve.ts";

/**
 * The link the bridge prints, which the Android app parses (Pairing.kt). Both
 * sides read `test/fixtures/pairing.json`, as they read `messages.jsonl`
 * (ADR 0007): a change to the link fails here, and a fixture the app cannot
 * parse fails `PairingTest.kt`.
 */
const fixture = await Bun.file(new URL("./fixtures/pairing.json", import.meta.url)).json() as { origin: string; code: string; link: string };

test("the pairing link carries the origin and the code, the code in the fragment", () => {
  expect(pairingLink(fixture.origin, fixture.code)).toBe(fixture.link);
  const link = new URL(fixture.link);
  expect(link.origin).toBe(fixture.origin);
  expect(link.hash).toBe(`#pair=${fixture.code}`);
  expect(link.search).toBe("");
});
