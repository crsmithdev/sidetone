import { expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApkHash, watchApk } from "../src/apk.ts";

test("the hash of the served app follows the file, and is undefined while there is none", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "apk-")), "app.apk");
  const hash = new ApkHash(path);
  expect(await hash.get()).toBeUndefined();
  writeFileSync(path, "one");
  expect(await hash.get()).toBe("7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed");
  // a new build of the same size is still a new file
  writeFileSync(path, "two");
  utimesSync(path, new Date(), new Date(Date.now() + 5_000));
  expect(await hash.get()).toBe("3fc4ccfe745870e2c0d99f71f30ff0656c8dedd41cc1d7d3d376b0dbe685e2f3");
});

test("a new build is told once, after two looks agree (17.15.5)", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "apk-")), "app.apk");
  const told: string[] = [];
  const stop = watchApk(new ApkHash(path), (sha256) => told.push(sha256), 10);
  const wait = () => new Promise((resolve) => setTimeout(resolve, 60));
  await wait();
  expect(told).toEqual([]);
  writeFileSync(path, "one");
  await wait();
  expect(told).toEqual(["7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed"]);
  writeFileSync(path, "two");
  utimesSync(path, new Date(), new Date(Date.now() + 5_000));
  await wait();
  stop();
  expect(told).toEqual(["7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed", "3fc4ccfe745870e2c0d99f71f30ff0656c8dedd41cc1d7d3d376b0dbe685e2f3"]);
});
