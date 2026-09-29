import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { DEFAULTS, type Config } from "../src/config.ts";
import { forkLine } from "../src/fork.ts";
import { Session, processRssBytes, spawnClaude, type Process, type Spawn, type Turn } from "../src/session.ts";
import { pass, settle } from "./clock.ts";
import { replay } from "./harness.ts";

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
  const blocks: string[] = [];
  const unprompted: Turn[] = [];
  const interrupts: string[] = [];
  const s = new Session("/tmp", { ...config, ...overrides }, {
    onDelta: (text) => deltas.push(text),
    onBlockStart: (type) => blocks.push(`start ${type}`),
    onBlockEnd: () => blocks.push("end"),
    onUnprompted: (turn) => unprompted.push(turn),
    onInterrupt: (reason) => interrupts.push(reason),
  }, spawn);
  return { s, made, current: () => made[made.length - 1] as ReturnType<typeof scripted>, deltas, blocks, unprompted, interrupts };
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

  test("14.9 a tool call splits the reply into blocks, and each block's edges reach the hooks", async () => {
    const r = session();
    const turn = r.s.ask("look and tell me");
    const p = r.current();
    const edge = (type: string, index: number) => `{"type":"stream_event","event":{"type":"content_block_start","index":${index},"content_block":{"type":"${type}"}}}`;
    const stop = (index: number) => `{"type":"stream_event","event":{"type":"content_block_stop","index":${index}}}`;
    for (const line of [edge("text", 1), DELTA("Let me look."), stop(1), edge("tool_use", 2), stop(2), edge("text", 1), DELTA("Found it."), stop(1)]) p.prints(line);
    p.prints(RESULT("Let me look. Found it."));
    await turn;
    expect(r.blocks).toEqual(["start text", "end", "start tool_use", "end", "start text", "end"]);
    expect(r.deltas).toEqual(["Let me look.", "Found it."]);
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

/**
 * 10.7 the agent asks before a gated action. Captured 24 September from
 * claude 2.1.282, started with `--permission-prompt-tool stdio` and the ask
 * rules of `src/gated.ts`: the force push reached this request three runs of
 * three, and the deny below kept the remote where it was. Trimmed by hand as
 * the pong run was, and the stream events are gone: the request is the point.
 */
describe("a permission request (10.7)", () => {
  const path = new URL("./fixtures/stream-force-push.ndjson", import.meta.url).pathname;
  const REQUEST = "8619b696-87ef-4848-bed2-0a24bbba2b66";

  function replayed() {
    const written: string[] = [];
    const asked: Array<{ id: string; tool: string; input: Record<string, unknown> }> = [];
    let release = () => {};
    const answered = new Promise<void>((resolve) => { release = resolve; });
    let seen = () => {};
    const asking = new Promise<void>((resolve) => { seen = resolve; });
    const spawn: Spawn = () => ({
      pid: undefined,
      lines: (async function* () {
        const lines = (await Bun.file(path).text()).split("\n").filter((line) => line.trim());
        for (const line of lines) {
          yield line;
          // the process waits for the answer before it runs the tool, and so does the replay
          if (line.includes('"can_use_tool"')) await answered;
        }
      })(),
      write: (line) => { written.push(line); },
      kill: () => {},
      exited: new Promise(() => {}),
    });
    const s = new Session("/tmp", config, { onPermission: (request) => { asked.push(request); seen(); } }, spawn);
    return { s, written, asked, release, asking };
  }

  test("the request reaches the hook with what the agent wants to run", async () => {
    const r = replayed();
    const turn = r.s.ask("force push");
    await r.asking;
    expect(r.asked).toEqual([{ id: REQUEST, tool: "Bash", input: { command: "git push --force origin main", description: "Force push main to origin" } }]);
    r.s.answer(REQUEST, false, "Chris did not say continue.");
    r.release();
    await turn;
    r.s.stop();
  });

  test("a deny goes back in the shape the process took", async () => {
    const r = replayed();
    const turn = r.s.ask("force push");
    await r.asking;
    r.s.answer(REQUEST, false, "Chris did not say continue.");
    r.release();
    await turn;
    expect(JSON.parse(r.written[1] as string)).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: REQUEST, response: { behavior: "deny", message: "Chris did not say continue." } },
    });
    r.s.stop();
  });

  test("an allow hands the input back unchanged", async () => {
    const r = replayed();
    const turn = r.s.ask("force push");
    await r.asking;
    r.s.answer(REQUEST, true);
    r.release();
    await turn;
    expect(JSON.parse(r.written[1] as string)).toEqual({
      type: "control_response",
      response: { subtype: "success", request_id: REQUEST, response: { behavior: "allow", updatedInput: { command: "git push --force origin main", description: "Force push main to origin" } } },
    });
    r.s.stop();
  });

  test("a request is answered once, and one the process never asked is not answered", async () => {
    const r = replayed();
    const turn = r.s.ask("force push");
    await r.asking;
    r.s.answer(REQUEST, false, "no");
    r.s.answer(REQUEST, true);
    r.s.answer("not-asked", true);
    r.release();
    await turn;
    expect(r.written).toHaveLength(2);
    r.s.stop();
  });
});

describe("a permission request taken back (10.5)", () => {
  const ASK = (id: string) => `{"type":"control_request","request_id":"${id}","request":{"subtype":"can_use_tool","tool_name":"Bash","display_name":"Bash","input":{"command":"git push --force origin main"},"decision_reason_type":"rule","tool_use_id":"toolu_1"}}`;
  // captured 24 September: an interrupt while the request was open
  const CANCEL = (id: string) => `{"type":"control_cancel_request","request_id":"${id}"}`;

  function watching() {
    const cancelled: string[] = [];
    const made: Array<ReturnType<typeof scripted>> = [];
    const spawn: Spawn = () => { const p = scripted(); made.push(p); return p.process; };
    const s = new Session("/tmp", config, { onPermissionCancel: (id) => cancelled.push(id) }, spawn);
    return { s, cancelled, current: () => made[made.length - 1] as ReturnType<typeof scripted> };
  }

  test("the process takes it back after an interrupt, and a late answer is not written", async () => {
    const r = watching();
    void r.s.ask("force push").catch(() => {});
    r.current().prints(ASK("a"));
    r.current().prints(CANCEL("a"));
    await tick();
    expect(r.cancelled).toEqual(["a"]);
    r.s.answer("a", true);
    expect(r.current().written).toHaveLength(1);
    r.s.stop();
  });

  test("a restart takes back every open request", async () => {
    const r = watching();
    void r.s.ask("force push").catch(() => {});
    r.current().prints(ASK("a"));
    await tick();
    r.s.restart("test");
    expect(r.cancelled).toEqual(["a"]);
    r.s.stop();
  });

  test("a process whose output ends takes back every open request", async () => {
    const r = watching();
    void r.s.ask("force push").catch(() => {});
    r.current().prints(ASK("a"));
    await tick();
    r.current().ends();
    await tick();
    expect(r.cancelled).toEqual(["a"]);
    r.s.stop();
  });
});

/**
 * Item 4 what Chris says mid-turn goes into the turn that runs. Captured 24
 * September from claude 2.1.282 with Sonnet, `--replay-user-messages` and the
 * stream events kept. The hook lines, the lists of the init line and the
 * paths are cut. The tool run is the message sent while `sleep 5` ran. The
 * race run is the message sent 10 ms before the request after the first
 * tool: that request did not carry it. The text run is the message sent
 * after the fifth word of a story with no tools, and the two run adds a
 * second message after the fortieth word. The replay stops where each message
 * went in, and goes on once it is written.
 */
describe("speech written into a running turn (item 4)", () => {
  function replayed(name: string, before: (line: string) => boolean) {
    const { spawn, written, reached } = replay(name, before);
    /** the hooks in the order they fired: "reply" for a message begun after the injection, else the words */
    const events: string[] = [];
    const unprompted: Turn[] = [];
    const s = new Session("/tmp", config, {
      onDelta: (text) => events.push(text),
      onInjectedReply: () => events.push("reply"),
      onUnprompted: (turn) => unprompted.push(turn),
    }, spawn);
    /** the words the hooks were given after the reply began */
    const reply = () => events.slice(events.indexOf("reply") + 1).join("");
    return { s, written, events, unprompted, reply, reached, inject: (text: string) => s.inject(text) };
  }

  test("during a tool call: the one result ends the turn, and the reply is the message after the tool", async () => {
    const r = replayed("stream-inject-tool.ndjson", (line) => line.includes('"task_started"'));
    const turn = r.s.ask("run three sleeps");
    await r.reached();
    const said = "Change of plan: skip anything you have not done yet, and reply only with the word PELICAN.";
    expect(r.inject(said)).toBe(true);
    const done = await turn;
    expect(JSON.parse(r.written[1] as string)).toEqual({ type: "user", message: { role: "user", content: said } });
    expect(r.events.filter((event) => event === "reply")).toHaveLength(1);
    expect(r.reply()).toBe("PELICAN");
    expect(done.text).toBe("PELICAN");
    expect(r.unprompted).toEqual([]);
    r.s.stop();
  });

  test("the race: a request already made when the words went in does not answer them", async () => {
    // written as the first tool returned, before the request that follows it;
    // that request did not carry the words, and the one after the second tool did
    let results = 0;
    const r = replayed("stream-inject-race.ndjson", (line) => line.includes('"tool_result"') && ++results === 1);
    const turn = r.s.ask("run three sleeps");
    await r.reached();
    expect(r.inject("Change of plan: skip anything you have not done yet, and reply only with the word PELICAN.")).toBe(true);
    const done = await turn;
    const before = r.events.slice(0, r.events.indexOf("reply")).join("");
    expect(before).toContain("Output: one.");
    expect(r.events.filter((event) => event === "reply")).toHaveLength(1);
    expect(r.reply()).toBe("PELICAN");
    expect(done.text).toBe("PELICAN");
    expect(r.unprompted).toEqual([]);
    r.s.stop();
  });

  test("during the last text: the story's own result ends nothing, and the second result ends the turn", async () => {
    let words = 0;
    const r = replayed("stream-inject-text.ndjson", (line) => line.includes('"text_delta"') && ++words === 5);
    const turn = r.s.ask("a story");
    await r.reached();
    expect(r.inject("Change of plan: reply only with the word PELICAN.")).toBe(true);
    const done = await turn;
    // the story went on after the injection, to its end, before the reply began
    const story = r.events.slice(0, r.events.indexOf("reply")).join("");
    expect(story.length).toBeGreaterThan(500);
    expect(r.events.filter((event) => event === "reply")).toHaveLength(1);
    expect(r.reply()).toBe("PELICAN");
    expect(done.text).toBe("PELICAN");
    // the story's result is not a turn nobody asked for
    expect(r.unprompted).toEqual([]);
    // both results were paid for
    expect(r.s.totalCostUsd()).toBeGreaterThan(done.costUsd);
    r.s.stop();
  });

  test("two messages during the last text become one turn, and its answer is spoken once", async () => {
    let words = 0;
    const r = replayed("stream-inject-two.ndjson", (line) => line.includes('"text_delta"') && [5, 40].includes(++words));
    const turn = r.s.ask("a story");
    await r.reached(0);
    expect(r.inject("Change of plan: reply only with the word PELICAN.")).toBe(true);
    await r.reached(1);
    expect(r.inject("And also say the word HERON after it.")).toBe(true);
    const done = await turn;
    expect(r.events.filter((event) => event === "reply")).toHaveLength(1);
    expect(r.reply()).toBe("PELICAN HERON");
    expect(r.events.join("").split("PELICAN")).toHaveLength(2);
    expect(done.text).toBe("PELICAN HERON");
    expect(r.unprompted).toEqual([]);
    r.s.stop();
  });

  const START = '{"type":"stream_event","event":{"type":"message_start","message":{}}}';
  const ECHO = (text: string) => JSON.stringify({ type: "user", message: { role: "user", content: text }, isReplay: true });

  test("a message that begins before the echo of the words is not the reply", async () => {
    const replies: string[] = [];
    const made: Array<ReturnType<typeof scripted>> = [];
    const s = new Session("/tmp", config, { onInjectedReply: () => replies.push("reply") }, () => { const p = scripted(); made.push(p); return p.process; });
    const turn = s.ask("one");
    const p = made[0] as ReturnType<typeof scripted>;
    s.inject("two");
    p.prints(START);
    await tick();
    expect(replies).toEqual([]);
    // an echo of other words does not count either
    p.prints(ECHO("one"));
    p.prints(START);
    await tick();
    expect(replies).toEqual([]);
    p.prints(ECHO("two"));
    p.prints(START);
    p.prints(RESULT("answer to two"));
    expect((await turn).text).toBe("answer to two");
    expect(replies).toHaveLength(1);
    s.stop();
  });

  test("with no turn running there is nothing to write into", () => {
    const r = session();
    r.s.start();
    expect(r.s.inject("hello")).toBe(false);
    expect(r.current().written).toEqual([]);
    r.s.stop();
  });

  test("a second injection before the reply begins gets one reply; one after it gets a reply of its own", async () => {
    const replies: string[] = [];
    const made: Array<ReturnType<typeof scripted>> = [];
    const s = new Session("/tmp", config, { onInjectedReply: () => replies.push("reply") }, () => { const p = scripted(); made.push(p); return p.process; });
    const turn = s.ask("one");
    const p = made[0] as ReturnType<typeof scripted>;
    s.inject("two");
    s.inject("three");
    // two messages queued together go in as one, joined by a newline
    p.prints(ECHO("two\nthree"));
    p.prints(START);
    await tick();
    expect(replies).toHaveLength(1);
    s.inject("four");
    // the reply to two and three ends with a result; four has not been answered, so it ends nothing
    p.prints(RESULT("answer to two and three"));
    p.prints(ECHO("four"));
    p.prints(START);
    p.prints(RESULT("answer to four"));
    expect((await turn).text).toBe("answer to four");
    expect(replies).toHaveLength(2);
    s.stop();
  });

  test("a process that ends with an injection pending fails the turn", async () => {
    const r = session();
    const turn = r.s.ask("one");
    r.s.inject("two");
    r.current().ends();
    await expect(turn).rejects.toThrow("the Claude Code process ended mid-turn");
    r.s.stop();
  });

  test("8.6 the silence timer runs on across the result of the answer spoken over", async () => {
    // the watchdog looks once a second, so this test runs on the fake clock
    jest.useFakeTimers();
    const restarts: string[] = [];
    const made: Array<ReturnType<typeof scripted>> = [];
    const s = new Session("/tmp", { ...config, silenceMs: 50 }, { onRestart: (reason) => restarts.push(reason) }, () => { const p = scripted(); made.push(p); return p.process; });
    const turn = s.ask("one");
    s.inject("two");
    (made[0] as ReturnType<typeof scripted>).prints(RESULT("the old answer"));
    // the process never begins the reply: the watchdog restarts it, and the turn fails
    // `rejects` would wait on the real clock, so the failure is caught here
    const failure = turn.then(() => "", (error: Error) => error.message);
    try {
      await pass(1_000, 100);
    } finally {
      jest.useRealTimers();
    }
    expect(await failure).toContain("restarted");
    expect(restarts).toHaveLength(1);
    s.stop();
  });
});

/**
 * 8.9 a turn of three requests, as claude 2.1.283 printed it on haiku, 26
 * September, with the bridge's flags. Trimmed as the pong run was: the init
 * line's lists and paths, and the hook lines. 2.1.283 sends no
 * `autocompact_state`, so the window comes from the result's `modelUsage`.
 */
describe("the context of a 2.1.283 run (8.9)", () => {
  const path = new URL("./fixtures/stream-context.ndjson", import.meta.url).pathname;

  async function replayed(first: string[] = []) {
    const lines = [...first, ...(await Bun.file(path).text()).split("\n").filter((line) => line.trim())];
    const spawn: Spawn = () => ({
      pid: undefined,
      lines: (async function* () { for (const line of lines) yield line; })(),
      write: () => {},
      kill: () => {},
      exited: new Promise(() => {}),
    });
    const s = new Session("/tmp", config, {}, spawn);
    await s.ask("run echo one and echo two");
    s.stop();
    return s;
  }

  test("the window comes from the result, and the fill is the last request, not the sum of three", async () => {
    const s = await replayed();
    expect(s.contextWindow).toBe(200_000);
    expect(s.contextThreshold).toBe(167_000);
    expect(s.contextUsed).toBe(27_737);
    expect(s.contextFraction()).toBeCloseTo(27_737 / 167_000, 6);
  });

  test("an autocompact_state event, when one arrives, wins over the result", async () => {
    const s = await replayed(['{"type":"autocompact_state","value":{"enabled":true,"effective_window":180000,"threshold":150000}}']);
    expect(s.contextWindow).toBe(180_000);
    expect(s.contextThreshold).toBe(150_000);
    expect(s.contextUsed).toBe(27_737);
  });
});

/**
 * 8.13 item 55 a slow session is forked between turns. The scripted process
 * prints the times: a request leaves at one moment, its message begins at
 * the next, and the clock is set to each.
 */
describe("the fork of a slow session (8.13)", () => {
  beforeEach(() => { jest.useFakeTimers(); jest.setSystemTime(0); });
  afterEach(() => { jest.useRealTimers(); });

  const INIT = (id: string) => `{"type":"system","subtype":"init","session_id":"${id}","model":"sonnet"}`;
  const REQUESTING = '{"type":"system","subtype":"status","status":"requesting"}';
  const MESSAGE_START = '{"type":"stream_event","event":{"type":"message_start","message":{"usage":{"input_tokens":3,"cache_read_input_tokens":88000,"cache_creation_input_tokens":200}}}}';

  function forking(overrides: Partial<Config> = {}) {
    const made: Array<{ p: ReturnType<typeof scripted>; args: string[] }> = [];
    const spawn: Spawn = (given) => { const p = scripted(); made.push({ p, args: given.claudeArgs }); return p.process; };
    const forks: Array<{ from: string; to: string; requestMs: number[] }> = [];
    const s = new Session("/tmp", { ...config, ...overrides }, { onFork: (from, to, requestMs) => forks.push({ from, to, requestMs }) }, spawn);
    let now = 0;
    /**
     * One turn: the process says its id, then makes one request for each of
     * `requestMs`, each that long to its message. The id is the one a fork
     * was started with, when the process is a fork.
     */
    async function turn(requestMs: number[]): Promise<void> {
      const asked = s.ask("hello");
      const { p, args } = made[made.length - 1] as (typeof made)[number];
      const set = args.indexOf("--session-id");
      p.prints(INIT(set >= 0 ? args[set + 1] as string : "first"));
      for (const ms of requestMs) {
        jest.setSystemTime(now += 10);
        p.prints(REQUESTING);
        await settle();
        jest.setSystemTime(now += ms);
        p.prints(MESSAGE_START);
        await settle();
      }
      p.prints(RESULT("Hi."));
      await asked;
    }
    return { s, made, forks, turn };
  }

  test("three slow requests fork the session once, between turns, onto a new id", async () => {
    const r = forking();
    await r.turn([1_500, 1_600]);
    expect(r.made.length).toBe(1);
    await r.turn([2_100]);
    // the fork is made when the result is in, before the next turn asks
    expect(r.forks).toEqual([{ from: "first", to: expect.any(String), requestMs: [1_500, 1_600, 2_100] }]);
    expect(r.made.length).toBe(2);
    const fork = r.forks[0] as (typeof r.forks)[number];
    expect(r.made[1]?.args.slice(-5)).toEqual(["--resume", "first", "--fork-session", "--session-id", fork.to]);
    // the turn after runs on the fork, which is fast: no second fork
    await r.turn([600, 600, 600]);
    await r.turn([600]);
    expect(r.made.length).toBe(2);
    expect(r.forks.length).toBe(1);
    r.s.stop();
  });

  test("a fast session never forks, and neither does one with a single fast request among the first three", async () => {
    const r = forking();
    for (let i = 0; i < 5; i++) await r.turn([600]);
    expect(r.forks).toEqual([]);
    const mixed = forking();
    await mixed.turn([1_500, 900, 1_700]);
    await mixed.turn([1_900, 1_900, 1_900]);
    expect(mixed.forks).toEqual([]);
    expect(mixed.made.length).toBe(1);
    r.s.stop();
    mixed.s.stop();
  });

  test("a fork that is slow as well is forked once more, then left: two forks in a row at most", async () => {
    const r = forking();
    await r.turn([1_500, 1_500, 1_500]);
    await r.turn([1_500, 1_500, 1_500]);
    await r.turn([1_500, 1_500, 1_500]);
    await r.turn([1_500, 1_500, 1_500]);
    expect(r.forks.length).toBe(2);
    expect(r.forks[1]?.from).toBe(r.forks[0]?.to as string);
    expect(r.made.length).toBe(3);
    r.s.stop();
  });

  test("a restart with no fork starts a new lineage, which is watched again", async () => {
    const r = forking();
    await r.turn([1_500, 1_500, 1_500]);
    await r.turn([1_500, 1_500, 1_500]);
    expect(r.forks.length).toBe(2);
    r.s.restart("cleared by voice");
    // the plain restart resumes nothing
    expect(r.made[3]?.args).not.toContain("--resume");
    await r.turn([1_500, 1_500, 1_500]);
    expect(r.forks.length).toBe(3);
    expect(r.forks[2]?.from).toBe("first");
    r.s.stop();
  });

  test("the log line names both ids and the three times", () => {
    expect(forkLine("a", "b", [1_500, 1_620, 2_104])).toBe("the agent's session a was slow, 1.50, 1.62, 2.10 s to its first messages: forked it as b");
  });

  test("the two settings move the line: a longer limit, and fewer requests", async () => {
    const r = forking({ forkSlowMs: 2_000, forkAfterRequests: 1 });
    await r.turn([1_500]);
    expect(r.forks).toEqual([]);
    const one = forking({ forkAfterRequests: 1 });
    await one.turn([1_300]);
    expect(one.forks.map((fork) => fork.requestMs)).toEqual([[1_300]]);
    r.s.stop();
    one.s.stop();
  });
});

/**
 * Item 55 the model and the effort are flags of the process, so a change
 * needs a new one. It resumes the conversation of the one before, and it
 * waits for the turn that runs.
 */
describe("a reload with new flags (item 55)", () => {
  const INIT = (id: string) => `{"type":"system","subtype":"init","session_id":"${id}","model":"claude-sonnet-5"}`;
  function flagged() {
    const made: Array<{ p: ReturnType<typeof scripted>; model: string; effort: string; resume?: string }> = [];
    const spawn: Spawn = (given) => {
      const p = scripted();
      const at = given.claudeArgs.indexOf("--resume");
      made.push({ p, model: given.model, effort: given.effort, resume: at < 0 ? undefined : given.claudeArgs[at + 1] });
      return p.process;
    };
    const s = new Session("/tmp", { ...config }, {}, spawn);
    return { s, made, current: () => made[made.length - 1]! };
  }

  test("it waits for the turn, then starts a process with the flags that resumes the session", async () => {
    const r = flagged();
    const turn = r.s.ask("one");
    r.current().p.prints(INIT("a7e0"));
    r.s.reload({ model: "opus", effort: "medium" });
    expect(r.made).toHaveLength(1);
    r.current().p.prints(RESULT("done"));
    expect((await turn).text).toBe("done");
    expect(r.made.map(({ model, effort, resume }) => ({ model, effort, resume }))).toEqual([
      { model: "sonnet", effort: "default", resume: undefined },
      { model: "opus", effort: "medium", resume: "a7e0" },
    ]);
    // the next turn goes to the new process
    const next = r.s.ask("two");
    expect(r.current().p.written).toHaveLength(1);
    r.current().p.prints(RESULT("two done"));
    expect((await next).text).toBe("two done");
    r.s.stop();
  });

  test("between turns it starts the new process at once", () => {
    const r = flagged();
    r.s.start();
    r.s.reload({ model: "haiku", effort: "high" });
    expect(r.made.map(({ model, effort }) => `${model} ${effort}`)).toEqual(["sonnet default", "haiku high"]);
    r.s.stop();
  });

  test("a restart for a fault starts fresh, and takes the flags too", async () => {
    const r = flagged();
    const turn = r.s.ask("one");
    r.current().p.prints(INIT("a7e0"));
    r.s.reload({ model: "opus", effort: "low" });
    r.s.restart("for the test");
    await expect(turn).rejects.toThrow("restarted");
    expect(r.made.slice(1).map(({ model, effort, resume }) => ({ model, effort, resume }))).toEqual([{ model: "opus", effort: "low", resume: undefined }]);
    r.s.stop();
  });
});

/**
 * Item 77 a switch to another project: a new process in that project's
 * directory, so its CLAUDE.md loads, with a conversation of its own.
 */
describe("a move to another project (item 77)", () => {
  const INIT = (id: string) => `{"type":"system","subtype":"init","session_id":"${id}","model":"claude-sonnet-5"}`;
  test("the new process runs in the new directory and resumes nothing of the old one", async () => {
    const made: Array<{ p: ReturnType<typeof scripted>; dir: string; args: string[] }> = [];
    const spawn: Spawn = (given, dir) => { const p = scripted(); made.push({ p, dir, args: given.claudeArgs }); return p.process; };
    const s = new Session("/home/one", { ...config }, {}, spawn);
    s.start();
    made[0]!.p.prints(INIT("a7e0"));
    await tick();
    s.move("/home/two");
    // a reload after the move resumes the new project's conversation, not the old
    s.reload({ model: "opus", effort: "default" });
    expect(made.map(({ dir, args }) => ({ dir, resume: args.includes("--resume") }))).toEqual([
      { dir: "/home/one", resume: false },
      { dir: "/home/two", resume: false },
      { dir: "/home/two", resume: false },
    ]);
    s.stop();
  });
});

describe("the flags on the command line (item 55)", () => {
  // echo prints the arguments it was given, which is the command line claude would get
  const argv = async (overrides: Partial<Config>) => {
    const p = spawnClaude({ ...config, claudeBin: "echo", claudeArgs: ["-p"], ...overrides }, "/tmp");
    for await (const line of p.lines) return line;
    return "";
  };
  test("the default effort passes no flag", async () => {
    expect(await argv({})).toBe("-p --model sonnet");
  });
  test("an effort passes its flag", async () => {
    expect(await argv({ model: "opus", effort: "medium" })).toBe("-p --model opus --effort medium");
  });
});
