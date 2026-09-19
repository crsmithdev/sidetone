import { describe, expect, test } from "bun:test";
import { DEFAULTS, type Config } from "../src/config.ts";
import { Session, processRssBytes, type Process, type Spawn, type Turn } from "../src/session.ts";

const config: Config = { ...DEFAULTS };
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

// 8.7 the recycle guard was dead code until something sampled the process size
describe("process memory (8.7)", () => {
  test("reads the resident size of a live process", () => {
    const bytes = processRssBytes(process.pid);
    expect(bytes).toBeGreaterThan(1024 * 1024);
  });
  test("a process that is gone reports nothing rather than zero", () => {
    expect(processRssBytes(2 ** 30)).toBeNull();
  });
});

/**
 * A process, scripted: the test decides what it prints and when, and reads
 * what it was told. This is the whole point of the seam: the pump, the turn,
 * the interrupt and the restart can all be driven with no Claude Code.
 */
function scripted() {
  const written: string[] = [];
  const queue: string[] = [];
  let waiting: ((result: IteratorResult<string>) => void) | null = null;
  let ended = false;
  const lines: AsyncIterable<string> = {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<string>> {
          if (queue.length > 0) return Promise.resolve({ value: queue.shift() as string, done: false });
          if (ended) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { waiting = resolve; });
        },
      };
    },
  };
  const deliver = (result: IteratorResult<string>) => {
    const to = waiting;
    waiting = null;
    to?.(result);
  };
  let exit = () => {};
  const exited = new Promise<void>((resolve) => { exit = resolve; });
  const process: Process = {
    pid: undefined,
    lines,
    write: (line) => { written.push(line); },
    kill: () => { ended = true; deliver({ value: undefined, done: true }); exit(); },
    exited,
  };
  return {
    process, written,
    /** the process prints a line */
    prints: (line: string) => { if (waiting) deliver({ value: line, done: false }); else queue.push(line); },
    /** the process's output ends, the way a dead process's does */
    ends: () => { ended = true; deliver({ value: undefined, done: true }); },
    /** the process is gone, whatever its stream did */
    dies: () => exit(),
  };
}

const DELTA = (text: string) => `{"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"${text}"}}}`;
const ASSISTANT = (text: string) => `{"type":"assistant","message":{"content":[{"type":"text","text":"${text}"}]}}`;
const RESULT = (text: string, isError = false) => `{"type":"result","subtype":"success","result":"${text}","total_cost_usd":0.01,"is_error":${isError},"usage":{"input_tokens":2,"output_tokens":4,"cache_read_input_tokens":100,"cache_creation_input_tokens":0}}`;
const RECEIPT = '{"type":"control_response","response":{"subtype":"success","response":{"still_queued":[]}}}';

function session(overrides: Partial<Config> = {}) {
  const made: Array<ReturnType<typeof scripted>> = [];
  const spawn: Spawn = () => { const p = scripted(); made.push(p); return p.process; };
  const deltas: string[] = [];
  const unprompted: Turn[] = [];
  const interrupts: string[] = [];
  const s = new Session("/tmp", { ...config, ...overrides }, {
    onDelta: (text) => deltas.push(text),
    onUnprompted: (turn) => unprompted.push(turn),
    onInterrupt: (reason) => interrupts.push(reason),
  }, spawn);
  return { s, made, current: () => made[made.length - 1] as ReturnType<typeof scripted>, deltas, unprompted, interrupts };
}

describe("a turn through the pump (7.2)", () => {
  test("the question goes in as a user message, and the reply comes back word by word", async () => {
    const r = session();
    const turn = r.s.ask("what is two plus two");
    const p = r.current();
    expect(p.written).toEqual(['{"type":"user","message":{"role":"user","content":"what is two plus two"}}']);
    p.prints(DELTA("Four"));
    p.prints(DELTA("."));
    p.prints(ASSISTANT("Four."));
    p.prints(RESULT("Four."));
    const done = await turn;
    expect(r.deltas).toEqual(["Four", "."]);
    expect(done).toMatchObject({ number: 1, text: "Four.", costUsd: 0.01, isError: false });
    expect(r.s.totalCostUsd()).toBe(0.01);
    r.s.stop();
  });

  test("a second question while one runs is refused, not queued", async () => {
    const r = session();
    const first = r.s.ask("one");
    await expect(r.s.ask("two")).rejects.toThrow("a turn is already running");
    r.current().prints(RESULT("done"));
    await first;
    r.s.stop();
  });

  test("the reply is what the result says, or what the text said when the result is empty", async () => {
    const r = session();
    const turn = r.s.ask("hello");
    r.current().prints(ASSISTANT("Hello, Chris."));
    r.current().prints(RESULT(""));
    expect((await turn).text).toBe("Hello, Chris.");
    r.s.stop();
  });
});

/**
 * 11.11 a turn nobody asked for. Claude Code answers a task notification on its
 * own; measured 18 September, four such turns across three runs, every word
 * dropped, because the delta sink only exists for a turn the bridge started.
 */
describe("a turn nobody asked for (11.11)", () => {
  test("a result with no question pending is handed over whole", async () => {
    const r = session();
    r.s.start();
    r.current().prints(ASSISTANT("The build is green."));
    r.current().prints(RESULT("The build is green."));
    await tick();
    expect(r.unprompted).toHaveLength(1);
    expect(r.unprompted[0]).toMatchObject({ text: "The build is green.", costUsd: 0.01 });
    r.s.stop();
  });
});

/**
 * Bun does not fill in exitCode unless something awaits exited, so a child
 * that died read as running through two attempts at writing the check. The
 * session watches the exit instead, and checks the identity, because a killed
 * child's promise resolves after its successor has already started.
 */
describe("whether the agent is there (8.7, the health check)", () => {
  test("a process that died reads as gone", async () => {
    const r = session();
    r.s.start();
    expect(r.s.running).toBe(true);
    r.current().dies();
    await tick();
    expect(r.s.running).toBe(false);
    r.s.stop();
  });

  test("the old process's exit does not mark its successor dead", async () => {
    const r = session();
    r.s.start();
    const old = r.current();
    r.s.restart("for the test");
    await tick();
    expect(r.made).toHaveLength(2);
    old.dies();
    await tick();
    expect(r.s.running).toBe(true);
    r.s.stop();
  });

  test("the old process's stream does not speak for its successor", async () => {
    const r = session();
    const first = r.s.ask("one");
    const old = r.current();
    r.s.restart("for the test");
    await expect(first).rejects.toThrow("restarted: for the test");
    const second = r.s.ask("two");
    // the dying process finishes a turn; it is not the current process, so nothing happens
    old.prints(RESULT("stale"));
    await tick();
    r.current().prints(RESULT("fresh"));
    expect((await second).text).toBe("fresh");
    r.s.stop();
  });
});

describe("the interrupt (8.6.5)", () => {
  test("it goes to the process as a control request, and the receipt is reported", async () => {
    const r = session();
    const turn = r.s.ask("something slow");
    r.s.interrupt();
    expect(r.current().written.at(-1)).toBe('{"type":"control_request","request":{"subtype":"interrupt"}}');
    r.current().prints(RECEIPT);
    await tick();
    expect(r.interrupts).toEqual(["the process took the interrupt"]);
    // what the real process does next: it returns a result, marked as an error
    r.current().prints(RESULT("error_during_execution", true));
    expect(await turn).toMatchObject({ isError: true });
    r.s.stop();
  });
});

describe("a process that ends mid-turn", () => {
  test("the turn fails rather than waiting for ever", async () => {
    const r = session();
    const turn = r.s.ask("one");
    r.current().ends();
    await expect(turn).rejects.toThrow("the Claude Code process ended mid-turn");
    r.s.stop();
  });
});

/**
 * A whole run, as Claude Code 2.1.278 printed it. `bun src/main.ts chat <dir>
 * --record-stream <file>` keeps one; this replays it through the session, so
 * the shapes the pump reads are the shapes the process prints. Trimmed by
 * hand: the init line's tool, skill and plugin lists and this machine's paths,
 * and what the session-start hooks printed. The bridge reads none of it.
 */
describe("a recorded run", () => {
  const path = new URL("./fixtures/stream-pong.ndjson", import.meta.url).pathname;

  test("replays through the session to the same turn", async () => {
    const lines = (await Bun.file(path).text()).split("\n").filter((line) => line.trim());
    const written: string[] = [];
    const spawn: Spawn = () => ({
      pid: undefined,
      lines: (async function* () { for (const line of lines) yield line; })(),
      write: (line) => { written.push(line); },
      kill: () => {},
      exited: new Promise(() => {}),
    });
    const deltas: string[] = [];
    const s = new Session("/tmp", config, { onDelta: (text) => deltas.push(text) }, spawn);
    const turn = await s.ask("say the word pong");
    expect(written).toHaveLength(1);
    expect(turn.number).toBe(1);
    expect(turn.isError).toBe(false);
    expect(turn.text.toLowerCase()).toContain("pong");
    expect(deltas.join("").toLowerCase()).toContain("pong");
    expect(turn.costUsd).toBeGreaterThan(0);
    expect(s.turns).toBe(1);
    s.stop();
  });
});
