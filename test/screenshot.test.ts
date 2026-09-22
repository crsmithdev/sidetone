import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Screenshots } from "../src/screenshot.ts";

function screenshots() {
  const dir = join(mkdtempSync(join(tmpdir(), "sidetone-screenshot-")), "screenshots");
  return { dir, s: new Screenshots(dir) };
}

/** Bytes that are not ASCII, so a wrong decode shows. */
const image = Buffer.from(Array.from({ length: 3_000 }, (_, n) => (n * 7) % 256));

/** The image as the app sends it: base64 in parts of `size` characters. */
function parts(id: string, bytes = image, size = 1_000) {
  const data = bytes.toString("base64");
  const count = Math.ceil(data.length / size);
  return Array.from({ length: count }, (_, n) => ({ kind: "screenshot", id, part: n + 1, of: count, data: data.slice(n * size, (n + 1) * size) }));
}

describe("the screenshot on disk (14.12)", () => {
  test("the parts of an image become one file, the journal hears of it once, and latest follows it", () => {
    const { dir, s } = screenshots();
    const file = join(dir, "1758472812345.jpg");
    const all = parts("1758472812345");
    expect(all.length).toBeGreaterThan(1);
    for (const part of all.slice(0, -1)) expect(s.receive(part)).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(s.receive(all.at(-1)!)).toEqual([`screenshot at ${file}`]);
    expect(readFileSync(file)).toEqual(image);
    expect(readlinkSync(join(dir, "latest.jpg"))).toBe("1758472812345.jpg");
  });

  test("parts out of order still make the image", () => {
    const { dir, s } = screenshots();
    for (const part of parts("a").reverse()) s.receive(part);
    expect(readFileSync(join(dir, "a.jpg"))).toEqual(image);
  });

  test("a new screenshot is a new file, and latest follows it", () => {
    const { dir, s } = screenshots();
    for (const part of parts("a")) s.receive(part);
    const other = Buffer.from("second");
    for (const part of parts("b", other)) s.receive(part);
    expect(readFileSync(join(dir, "a.jpg"))).toEqual(image);
    expect(readFileSync(join(dir, "b.jpg"))).toEqual(other);
    expect(readlinkSync(join(dir, "latest.jpg"))).toBe("b.jpg");
  });

  test("an image that is not whole when the next one starts is dropped and said", () => {
    const { dir, s } = screenshots();
    s.receive(parts("a")[0]!);
    const said = parts("b", Buffer.from("second")).flatMap((part) => s.receive(part));
    expect(said).toEqual(["the screenshot a from the phone was not whole, and is dropped", `screenshot at ${join(dir, "b.jpg")}`]);
    expect(existsSync(join(dir, "a.jpg"))).toBe(false);
  });

  test("a message that is not readable writes nothing and says so", () => {
    const { dir, s } = screenshots();
    for (const bad of [
      { kind: "screenshot" },
      { kind: "screenshot", id: "../escape", part: 1, of: 1, data: "" },
      { kind: "screenshot", id: "a", part: 1, of: 1, data: 7 },
      { kind: "screenshot", id: "a", part: 2, of: 1, data: "" },
      { kind: "screenshot", id: "a", part: 0, of: 1, data: "" },
      { kind: "screenshot", id: "a", part: 1, of: 1_000_000, data: "" },
    ]) expect(s.receive(bad)).toEqual(["a part of a screenshot from the phone was not readable"]);
    expect(existsSync(dir)).toBe(false);
  });

  test("a directory that cannot be made is said, not thrown", () => {
    const blocked = new Screenshots("/proc/sidetone-cannot-exist/screenshots");
    expect(blocked.receive(parts("a", Buffer.from("x"))[0]!)[0]).toStartWith("the screenshot was not written:");
  });
});
