import { expect, test } from "bun:test";
import { mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApkHash } from "../src/apk.ts";

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
