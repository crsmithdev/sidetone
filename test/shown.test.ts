import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_MESSAGE_BYTES } from "../src/outbound.ts";
import { Pairing, routes } from "../src/routes.ts";
import { Shown, showFile } from "../src/shown.ts";
import { bridge } from "./harness.ts";

/** A shown file (17.23, item 78): the command, the route, the message and the download. */
const HERE = "127.0.0.1";
const TAILNET = "100.68.96.43";
const PDF = "%PDF-1.4\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n";

function project() {
  const dir = mkdtempSync(join(tmpdir(), "sidetone-shown-"));
  mkdirSync(join(dir, "docs"));
  writeFileSync(join(dir, "docs", "plan.md"), "# Plan\n\n- **one**\n");
  writeFileSync(join(dir, "notes.txt"), "plain words\n");
  writeFileSync(join(dir, "docs", "paper.pdf"), PDF);
  writeFileSync(join(dir, "fake.pdf"), "not a pdf at all");
  writeFileSync(join(dir, "photo.png"), new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
  return dir;
}

function site(dir: string) {
  const r = bridge();
  let ids = 0;
  const handle = routes({
    config: r.config,
    bridge: r,
    pairing: new Pairing("kelp-cedar-jetty", async () => ({ token: "t", url: "wss://bridge:7880", room: "sidetone" })),
    page: "",
    files: { sdk: "/nowhere", decoder: "/nowhere", apk: "/nowhere" },
    health: () => ({ room: true, speech: true, transcription: true, microphone: true, sinceSound: 0 }),
    shown: new Shown(dir, "https://bridge:3100", () => `id-${++ids}`),
    startedAt: Date.now(),
  });
  const show = (file: string, ip = HERE) =>
    handle(new Request("http://bridge/show", { method: "POST", body: JSON.stringify({ file }) }), ip);
  const get = (path: string, ip = TAILNET) => handle(new Request(`http://bridge${path}`), ip);
  return { ...r, show, get, handle };
}

describe("the show message (17.23.2)", () => {
  test("markdown goes whole in the message, named from the project", async () => {
    const dir = project();
    const s = site(dir);
    const response = await s.show(join(dir, "docs", "plan.md"));
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ shown: "docs/plan.md" });
    expect(s.told.filter((m) => m.kind === "show")).toEqual([
      { kind: "show", id: "id-1", name: "docs/plan.md", format: "markdown", text: "# Plan\n\n- **one**\n" },
    ]);
    expect(s.journal.some((line) => line.includes("showed the phone docs/plan.md"))).toBe(true);
  });

  test("any other text is text", async () => {
    const dir = project();
    const s = site(dir);
    await s.show(join(dir, "notes.txt"));
    expect(s.told.find((m) => m.kind === "show")).toMatchObject({ format: "text", name: "notes.txt", text: "plain words\n" });
  });

  test("a PDF is an address to download, and a file outside the project keeps its absolute path", async () => {
    const dir = project();
    const s = site(join(dir, "docs", "elsewhere"));
    await s.show(join(dir, "docs", "paper.pdf"));
    expect(s.told.find((m) => m.kind === "show")).toEqual({
      kind: "show", id: "id-1", name: join(dir, "docs", "paper.pdf"), format: "pdf", url: "https://bridge:3100/shown/id-1", bytes: PDF.length,
    });
  });

  test("an image, a PDF that is not one, a relative path and a missing file are refused, and nothing is sent", async () => {
    const dir = project();
    const s = site(dir);
    expect((await s.show(join(dir, "photo.png"))).status).toBe(415);
    expect((await s.show(join(dir, "fake.pdf"))).status).toBe(415);
    expect((await s.show("docs/plan.md")).status).toBe(400);
    expect((await s.show(join(dir, "gone.md"))).status).toBe(400);
    expect(s.told.some((m) => m.kind === "show")).toBe(false);
  });

  test("a text too large for one data message is refused with its size", async () => {
    const dir = project();
    writeFileSync(join(dir, "big.md"), "x".repeat(MAX_MESSAGE_BYTES));
    const s = site(dir);
    const response = await s.show(join(dir, "big.md"));
    expect(response.status).toBe(413);
    expect(((await response.json()) as { error: string }).error).toContain(`${MAX_MESSAGE_BYTES} bytes`);
  });
});

describe("the PDF download (17.23.3)", () => {
  test("the phone downloads a shown PDF by its id, and nothing else", async () => {
    const dir = project();
    const s = site(dir);
    await s.show(join(dir, "docs", "paper.pdf"));
    const response = await s.get("/shown/id-1");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(await response.text()).toBe(PDF);
    expect((await s.get("/shown/id-2")).status).toBe(404);
    // a shown text file is in its message, and has no address
    await s.show(join(dir, "notes.txt"));
    expect((await s.get("/shown/id-2")).status).toBe(404);
  });
});

describe("sidetone show (17.23.1)", () => {
  test("the command sends the absolute path from where it runs, and says what the phone shows", async () => {
    const asked: Array<{ url: string; body: unknown }> = [];
    const send = (async (url: string, init: RequestInit) => {
      asked.push({ url, body: JSON.parse(init.body as string) });
      return Response.json({ shown: "docs/plan.md" }, { status: 202 });
    }) as unknown as typeof fetch;
    const result = await showFile("docs/plan.md", "/home/chris/project", "https://127.0.0.1:3100", send);
    expect(asked).toEqual([{ url: "https://127.0.0.1:3100/show", body: { file: "/home/chris/project/docs/plan.md" } }]);
    expect(result).toEqual({ ok: true, line: "showing docs/plan.md on the phone" });
  });

  test("the command says the bridge's reason when it refuses, and when the bridge is not there", async () => {
    const refuse = (async () => Response.json({ error: "photo.png is not text, markdown or a PDF" }, { status: 415 })) as unknown as typeof fetch;
    expect(await showFile("/p/photo.png", "/", "http://127.0.0.1:3100", refuse)).toEqual({ ok: false, line: "photo.png is not text, markdown or a PDF" });
    const down = (async () => { throw new Error("Connection refused"); }) as unknown as typeof fetch;
    const result = await showFile("a.md", "/", "http://127.0.0.1:3100", down);
    expect(result.ok).toBe(false);
    expect(result.line).toContain("not answering");
  });

  test("end to end: the command reaches the route through a real server", async () => {
    const dir = project();
    const s = site(dir);
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: (request, srv) => s.handle(request, srv.requestIP(request)?.address) });
    try {
      const result = await showFile("docs/plan.md", dir, `http://127.0.0.1:${server.port}`);
      expect(result).toEqual({ ok: true, line: "showing docs/plan.md on the phone" });
      expect(s.told.find((m) => m.kind === "show")).toMatchObject({ name: "docs/plan.md", format: "markdown" });
    } finally {
      server.stop(true);
    }
  });
});
