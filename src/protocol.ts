/**
 * Claude Code's stream-json output, reduced to what the bridge acts on.
 *
 * Shapes confirmed against claude 2.1.267, and the result again against 2.1.283, with
 *   -p --verbose --input-format stream-json --output-format stream-json
 * Anything unrecognised still counts as activity, which is the point: the
 * silence detector must not go blind when a new event type appears.
 */

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export type Event =
  | { kind: "init"; sessionId: string; model: string }
  /** the context window and the compaction threshold, in tokens */
  | { kind: "context"; window: number; threshold: number; enabled: boolean }
  | { kind: "rateLimit"; fiveHour: number; sevenDay: number; resetsAt: number }
  | { kind: "text"; text: string }
  /** 5.5 the reply word by word, so 5.6 can collect it to a sentence and speak it */
  | { kind: "delta"; text: string }
  /**
   * 14.9 a block of the reply begins, and `type` says what it holds: "text" for
   * words, "tool_use" for a tool call, "thinking". The stream's own index restarts
   * with each message of the agent, so it names nothing across a tool call.
   */
  | { kind: "blockStart"; type: string }
  | { kind: "blockEnd" }
  /**
   * item 4 a message of the agent begins; the bridge speaks only a message that began after an injection.
   * 18.4.1 `usage` is what its request read: the cache it hit and the cache it wrote.
   */
  | { kind: "messageStart"; usage: Usage }
  /** 18.4.1 a request for the next message of the agent leaves */
  | { kind: "requesting" }
  /**
   * 18.4.1 the process's estimate of the thinking grew by `tokens`. Measured 25
   * September: a short thinking block of 20 tokens gave no estimate at all.
   */
  | { kind: "thinking"; tokens: number }
  /**
   * Item 4 `--replay-user-messages` prints a user message again when the
   * process puts it into the conversation, not when it reads it. Queued
   * messages that go in together come back as one, joined by a newline.
   */
  | { kind: "echo"; text: string }
  /** 8.6.5 the receipt for a control request; still_queued names the turns it dropped */
  | { kind: "controlResponse"; ok: boolean; stillQueued: string[] }
  /** 10.7 the process asks before a tool runs (`--permission-prompt-tool stdio`) and waits for the answer */
  | { kind: "permission"; id: string; tool: string; input: Record<string, unknown> }
  /** 10.7 the process takes a request back, as it does when an interrupt lands on one */
  | { kind: "permissionCancel"; id: string }
  /** parentId names the Agent call this one runs inside, or null at the top level */
  | { kind: "toolStart"; id: string; tool: string; parentId: string | null }
  | { kind: "toolEnd"; id: string; parentId: string | null }
  | { kind: "compaction" }
  /**
   * `usage` sums every request of the turn. `request` is the last request
   * alone, which is what the context holds now (8.9). `window` and
   * `maxOutput` are the main model's, or 0 when the result names no model.
   */
  | { kind: "result"; text: string; costUsd: number; usage: Usage; request: Usage; window: number; maxOutput: number; isError: boolean }
  | { kind: "other"; type: string };

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function usageOf(raw: unknown): Usage {
  const u = (raw ?? {}) as Record<string, unknown>;
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    cacheReadTokens: num(u.cache_read_input_tokens),
    cacheCreationTokens: num(u.cache_creation_input_tokens),
  };
}

/** 8.9 the fill: the tokens one request read, cached or not. */
export function contextTokens(usage: Usage): number {
  return usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens;
}

/**
 * 8.9 the token count at which claude 2.1.283 compacts: the window, less the
 * output it keeps free (at most 20,000), less a margin of 13,000. This is
 * claude's own rule, read from its code (`B4` and `P7`), not a field.
 */
export function compactionThreshold(window: number, maxOutput: number): number {
  return window - Math.min(maxOutput, 20_000) - 13_000;
}

/**
 * 8.9 the main model of a result: the entry of `modelUsage` that read the most.
 * A side call on a small model can share the result, and reads less.
 */
function mainModel(raw: unknown): { window: number; maxOutput: number } {
  let best = { read: -1, window: 0, maxOutput: 0 };
  for (const entry of Object.values((raw ?? {}) as Record<string, Record<string, unknown>>)) {
    const read = num(entry?.inputTokens) + num(entry?.cacheReadInputTokens) + num(entry?.cacheCreationInputTokens);
    if (read > best.read) best = { read, window: num(entry?.contextWindow), maxOutput: num(entry?.maxOutputTokens) };
  }
  return { window: best.window, maxOutput: best.maxOutput };
}

/** One line of NDJSON becomes zero or more events; one assistant message can carry both text and a tool call. */
export function parseLine(line: string): Event[] {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(line); } catch { return []; }
  const type = typeof raw.type === "string" ? raw.type : "";
  const subtype = typeof raw.subtype === "string" ? raw.subtype : "";

  // a compaction can arrive as its own event or as a system subtype; match on the word
  if (type.includes("compact") && type !== "autocompact_state") return [{ kind: "compaction" }];
  if (subtype.includes("compact")) return [{ kind: "compaction" }];

  if (type === "autocompact_state") {
    const v = (raw.value ?? {}) as Record<string, unknown>;
    return [{ kind: "context", window: num(v.effective_window), threshold: num(v.threshold), enabled: v.enabled === true }];
  }
  if (type === "rate_limit_event") {
    const info = (raw.rate_limit_info ?? {}) as Record<string, unknown>;
    const windows = (info.unifiedWindows ?? {}) as Record<string, { utilization?: unknown; resetsAt?: unknown }>;
    return [{
      kind: "rateLimit",
      fiveHour: num(windows.five_hour?.utilization),
      sevenDay: num(windows.seven_day?.utilization),
      resetsAt: num(info.resetsAt),
    }];
  }
  if (type === "system" && subtype === "status" && raw.status === "requesting") return [{ kind: "requesting" }];
  if (type === "system" && subtype === "thinking_tokens") return [{ kind: "thinking", tokens: num(raw.estimated_tokens_delta) }];
  if (type === "system" && subtype === "init") {
    return [{ kind: "init", sessionId: String(raw.session_id ?? ""), model: String(raw.model ?? "") }];
  }
  if (type === "result") {
    const usage = (raw.usage ?? {}) as Record<string, unknown>;
    // measured on 2.1.283: `iterations` holds only the last request of the turn
    const last = Array.isArray(usage.iterations) ? usage.iterations.at(-1) : undefined;
    return [{
      kind: "result",
      text: typeof raw.result === "string" ? raw.result : "",
      costUsd: num(raw.total_cost_usd),
      usage: usageOf(usage),
      request: usageOf(last ?? usage),
      ...mainModel(raw.modelUsage),
      isError: raw.is_error === true,
    }];
  }
  // --include-partial-messages streams the reply as text deltas and repeats it whole
  // in the assistant message that follows. Only the whole message becomes "text",
  // so the reply is never counted twice; the deltas are the voice path.
  // The blocks are what the deltas sit in: a text block, then a tool call, then
  // another text block. A subagent's own messages arrive whole, not as stream events.
  if (type === "stream_event") {
    const event = (raw.event ?? {}) as Record<string, unknown>;
    const delta = (event.delta ?? {}) as Record<string, unknown>;
    if (delta.type === "text_delta" && typeof delta.text === "string") return [{ kind: "delta", text: delta.text }];
    if (event.type === "content_block_start") {
      const block = (event.content_block ?? {}) as Record<string, unknown>;
      return [{ kind: "blockStart", type: String(block.type ?? "") }];
    }
    if (event.type === "content_block_stop") return [{ kind: "blockEnd" }];
    if (event.type === "message_start") {
      const message = (event.message ?? {}) as Record<string, unknown>;
      return [{ kind: "messageStart", usage: usageOf(message.usage) }];
    }
    return [{ kind: "other", type: `stream_event.${String(event.type ?? "")}` }];
  }
  if (type === "control_request") {
    const request = (raw.request ?? {}) as Record<string, unknown>;
    if (request.subtype === "can_use_tool") {
      return [{ kind: "permission", id: String(raw.request_id ?? ""), tool: String(request.tool_name ?? ""), input: (request.input ?? {}) as Record<string, unknown> }];
    }
  }
  if (type === "control_cancel_request") return [{ kind: "permissionCancel", id: String(raw.request_id ?? "") }];
  if (type === "control_response") {
    const response = (raw.response ?? {}) as Record<string, unknown>;
    const inner = (response.response ?? {}) as Record<string, unknown>;
    const queued = Array.isArray(inner.still_queued) ? inner.still_queued.map(String) : [];
    return [{ kind: "controlResponse", ok: response.subtype === "success", stillQueued: queued }];
  }
  if (type === "user" && raw.isReplay === true) {
    const message = (raw.message ?? {}) as Record<string, unknown>;
    return [{ kind: "echo", text: typeof message.content === "string" ? message.content : "" }];
  }
  if (type === "assistant" || type === "user") {
    const message = (raw.message ?? {}) as Record<string, unknown>;
    const content = Array.isArray(message.content) ? message.content : [];
    // a subagent's own tool calls arrive on this same stream, named by the Agent
    // call they run inside, so the bridge never goes blind inside a subagent
    const parentId = typeof raw.parent_tool_use_id === "string" ? raw.parent_tool_use_id : null;
    const out: Event[] = [];
    for (const part of content as Record<string, unknown>[]) {
      if (part?.type === "text" && typeof part.text === "string") out.push({ kind: "text", text: part.text });
      else if (part?.type === "tool_use") out.push({ kind: "toolStart", id: String(part.id ?? ""), tool: String(part.name ?? ""), parentId });
      else if (part?.type === "tool_result") out.push({ kind: "toolEnd", id: String(part.tool_use_id ?? ""), parentId });
    }
    return out.length ? out : [{ kind: "other", type }];
  }
  return [{ kind: "other", type: type || "unknown" }];
}

/** One line at a time out of a byte stream, holding a partial line until its newline arrives. */
export async function* linesOf(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const splitter = new LineSplitter();
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    for (const line of splitter.push(decoder.decode(chunk, { stream: true }))) yield line;
  }
}

/** Split a stream into whole lines, holding the tail until its newline arrives. */
export class LineSplitter {
  private buffer = "";
  push(chunk: string): string[] {
    this.buffer += chunk;
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";
    return lines.filter((line) => line.trim());
  }
}
