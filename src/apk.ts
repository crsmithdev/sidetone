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

/**
 * 17.15.5 calls `changed` with each new hash of the file, so a client already
 * in the room hears of a new build. A build writes the file for some seconds,
 * so a hash counts only when two looks in a row agree.
 */
export function watchApk(hash: ApkHash, changed: (sha256: string) => void, everyMs = 2_000): () => void {
  let seen: string | undefined;
  let offered: string | undefined;
  const timer = setInterval(async () => {
    // a file that goes away during the read is a build in progress, not a crash
    const sha256 = await hash.get().catch(() => undefined);
    if (sha256 && sha256 === seen && sha256 !== offered) {
      offered = sha256;
      changed(sha256);
    }
    seen = sha256;
  }, everyMs);
  return () => clearInterval(timer);
}
