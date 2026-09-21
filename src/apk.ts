/**
 * 17.15 the SHA-256 of the app the bridge serves. The app hashes its own
 * installed file and compares, so the bridge needs no version numbers.
 *
 * The file is about 70 MB and a build replaces it while the bridge runs, so
 * the hash is kept until the size or the time of the file changes.
 */
import { stat } from "node:fs/promises";

export class ApkHash {
  private kept: { key: string; sha256: string } | null = null;

  constructor(private readonly path: string) {}

  /** The hash in hex, or undefined when no app is built. */
  async get(): Promise<string | undefined> {
    const info = await stat(this.path).catch(() => null);
    if (!info) return undefined;
    const key = `${info.size} ${info.mtimeMs}`;
    if (this.kept?.key === key) return this.kept.sha256;
    const sha256 = new Bun.CryptoHasher("sha256").update(await Bun.file(this.path).arrayBuffer()).digest("hex");
    this.kept = { key, sha256 };
    return sha256;
  }
}
