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
  function replayed(name: string, before: (line: string, index: number) => boolean) {
    const path = new URL(`./fixtures/${name}`, import.meta.url).pathname;
    const written: string[] = [];
    /** the hooks in the order they fired: "reply" for a message begun after the injection, else the words */
    const events: string[] = [];
    const unprompted: Turn[] = [];
    /** one place for each injection: the replay waits there until the test writes it */
    const stops: Array<{ reached: Promise<void>; seen(): void; go: Promise<void>; release(): void }> = [];
    const stop = (n: number) => {
      while (stops.length <= n) {
        let seen = () => {};
        let release = () => {};
        const reached = new Promise<void>((resolve) => { seen = resolve; });
        const go = new Promise<void>((resolve) => { release = resolve; });
        stops.push({ reached, seen, go, release });
      }
      return stops[n] as (typeof stops)[number];
    };
    const spawn: Spawn = () => ({
      pid: undefined,
      lines: (async function* () {
        const lines = (await Bun.file(path).text()).split("\n").filter((line) => line.trim());
        let n = 0;
        for (const [index, line] of lines.entries()) {
          yield line;
          if (before(line, index)) { const at = stop(n++); at.seen(); await at.go; }
        }
      })(),
      write: (line) => { written.push(line); },
      kill: () => {},
      exited: new Promise(() => {}),
    });
    const s = new Session("/tmp", config, {
      onDelta: (text) => events.push(text),
      onInjectedReply: () => events.push("reply"),
      onUnprompted: (turn) => unprompted.push(turn),
    }, spawn);
    /** the words the hooks were given after the reply began */
    const reply = () => events.slice(events.indexOf("reply") + 1).join("");
    let injections = 0;
    return {
      s, written, events, unprompted, reply,
      reached: (n = 0) => stop(n).reached,
      inject: (text: string) => { const ok = s.inject(text); stop(injections++).release(); return ok; },
    };
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
    const restarts: string[] = [];
    const made: Array<ReturnType<typeof scripted>> = [];
    const s = new Session("/tmp", { ...config, silenceMs: 50 }, { onRestart: (reason) => restarts.push(reason) }, () => { const p = scripted(); made.push(p); return p.process; });
    const turn = s.ask("one");
    s.inject("two");
    (made[0] as ReturnType<typeof scripted>).prints(RESULT("the old answer"));
    // the process never begins the reply: the watchdog restarts it, and the turn fails
    await expect(turn).rejects.toThrow("restarted");
    expect(restarts).toHaveLength(1);
    s.stop();
  });
});
