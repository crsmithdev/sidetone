import { expect, test } from "bun:test";
import { pairingLink } from "../src/serve.ts";

// The Android app parses this shape (android/.../Pairing.kt). Change both or neither.
test("the pairing link carries the origin and the code, the code in the fragment", () => {
  const link = new URL(pairingLink("https://lightbox2.tail15c879.ts.net:3100", "kelp-cedar-jetty"));
  expect(link.origin).toBe("https://lightbox2.tail15c879.ts.net:3100");
  expect(link.hash).toBe("#pair=kelp-cedar-jetty");
  expect(link.search).toBe("");
});
