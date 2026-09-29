/**
 * A shown file (spec 17.23, item 78): a file the agent puts on the phone's
 * screen while it talks about it.
 *
 * The agent runs `sidetone show <path>`, which is `showFile` below. The
 * command sends the absolute path to `POST /show` on this machine, and the
 * route asks `Shown` for the message. Text and markdown go in the message
 * whole. A PDF does not fit one data message, so the message carries an
 * address under `/shown/`, and the app downloads the file from it.
 *
 * Read only: the app shows the file and never writes it back.
 */
import { isAbsolute, relative, resolve } from "node:path";
import type { Outgoing } from "./messages.ts";
import { MAX_MESSAGE_BYTES } from "./outbound.ts";

export type Show = Extract<Outgoing, { kind: "show" }>;

/** What `/show` answers: the message to send, or the status and the reason it refuses. */
export type Showing = { message: Show } | { status: number; error: string };

const MARKDOWN = /\.(md|markdown)$/i;
const PDF = /\.pdf$/i;

export class Shown {
  /** The PDFs the app may download, by id. They live as long as the process. */
  private readonly pdfs = new Map<string, string>();

  constructor(
    /** the project: a file in it is named by its path from here, as the agent names it aloud (6.6) */
    private readonly dir: string,
    /** where the phone reaches this bridge, as for the app (17.15) */
    private readonly origin: string,
    private readonly newId: () => string = () => crypto.randomUUID(),
  ) {}

  /** The message that shows `file`, an absolute path, on the phone; or why it cannot. */
  async show(file: string): Promise<Showing> {
    if (!isAbsolute(file)) return { status: 400, error: "file must be an absolute path" };
    const handle = Bun.file(file);
    if (!(await handle.exists())) return { status: 400, error: `${file} does not exist` };
    const id = this.newId();
    const name = this.nameOf(file);
    const bytes = new Uint8Array(await handle.arrayBuffer());
    if (PDF.test(file)) {
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") return { status: 415, error: `${name} is not a PDF` };
      this.pdfs.set(id, file);
      return { message: { kind: "show", id, name, format: "pdf", url: `${this.origin}/shown/${id}`, bytes: bytes.byteLength } };
    }
    let text: string;
    try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { text = "\0"; }
    if (text.includes("\0")) return { status: 415, error: `${name} is not text, markdown or a PDF` };
    const message: Show = { kind: "show", id, name, format: MARKDOWN.test(file) ? "markdown" : "text", text };
    // the whole text goes in one data message (14.11), so the message is measured, not the file
    const size = new TextEncoder().encode(JSON.stringify(message)).byteLength;
    if (size > MAX_MESSAGE_BYTES) return { status: 413, error: `${name} is ${bytes.byteLength} bytes; a shown text file fits in ${MAX_MESSAGE_BYTES} bytes of message` };
    return { message };
  }

  /** The path of a shown PDF, for `/shown/<id>`; undefined for an id this process did not give. */
  pdf(id: string): string | undefined {
    return this.pdfs.get(id);
  }

  private nameOf(file: string): string {
    const inside = relative(this.dir, file);
    return inside && !inside.startsWith("..") && !isAbsolute(inside) ? inside : file;
  }
}

/**
 * `sidetone show <path>`: ask the bridge on this machine to show a file. The
 * path is from `cwd`, as a shell gives it. The bridge's certificate names the
 * tailnet host, not the loopback, so the command does not check it.
 */
export async function showFile(path: string, cwd: string, base: string, send: typeof fetch = fetch): Promise<{ ok: boolean; line: string }> {
  const file = resolve(cwd, path);
  let response: Response;
  try {
    response = await send(`${base}/show`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file }),
      tls: { rejectUnauthorized: false },
    } as RequestInit);
  } catch (error) {
    return { ok: false, line: `the bridge is not answering at ${base}: ${(error as Error).message}` };
  }
  const body = await response.json().catch(() => ({})) as { shown?: string; error?: string };
  if (response.status !== 202) return { ok: false, line: body.error ?? `the bridge answered ${response.status}` };
  return { ok: true, line: `showing ${body.shown} on the phone` };
}
