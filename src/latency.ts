/**
 * How long the round trip really takes (spec 18.4).
 *
 * The car test said the latency felt good. Felt is not measured, and the one
 * number that matters is the one the person on the phone lives with: from the
 * moment Chris stops talking to the moment the first sound of the answer
 * leaves the bridge. Everything between is the bridge's own doing.
 *
 * The clock starts at the real end of speech, not at the moment the bridge
 * notices it. The bridge only notices after the end-of-turn pause, so that
 * pause is subtracted by the caller — otherwise every measurement carries a
 * setting as if it were a cost.
 */

import type { Event } from "./protocol.ts";
import type { WorkerTimes } from "./speech.ts";

export interface Round {
  /**
   * 11.5 the end-of-turn pause, which is a setting and not a cost. The bridge
   * cannot know a turn ended until the pause has run, so this sits in every
   * round trip and belongs on its own line rather than inside the engine's.
   */
  pauseMs: number;
  /** the engine's share: the recording becomes text */
  transcribeMs: number;
  /** the whole of it: the end of speech to the first audio out */
  answerMs: number;
  /**
   * The rest of it, split three ways, because the remainder used to be one
   * number that mixed the agent's thinking with the engine's synthesis, and
   * no change to either could be judged from the record. Zero when the mark
   * was never made, which the desk loop and a command's reply both do.
   */
  /** the agent's share: the text went in, the first word came back */
  agentMs: number;
  /** the collector's share: the first word to the first whole sentence */
  sentenceMs: number;
  /** the engine's share: that sentence became a wav */
  synthesisMs: number;
}

/**
 * 18.4.1 where the agent's time to the first word went, from its stream. A
 * field the stream did not give is left out, not zero.
 */
export interface AgentTimes {
  /** what the turn's first request read: new input, cache hit, cache written */
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  /**
   * the thinking of every message up to the one that holds the first word,
   * that one included: the exact count of each message that ended before the
   * round closed, and the estimate of one that still ran
   */
  thinkingTokens?: number;
  /** what the first block held: "text", "tool_use" or "thinking" */
  firstEvent?: string;
  /** the tool calls before the first word */
  toolsBeforeText?: number;
  /** the first request left, to its first message began: network and queue */
  requestMs?: number;
}

/** 18.4.1 a round, with what the worker says the sentence cost it when it says, and what the agent's stream says. */
export type TimedRound = Round & Partial<WorkerTimes> & AgentTimes;

/** Enough rounds to have a median, few enough that a drive ago does not count. */
const KEEP = 20;

/** What a barge-in turned out to be, once the utterance behind it was read. */
export type Outcome = "speech" | "command" | "nothing";

export class Latency {
  private open: {
    endedAt: number; noticedAt: number; transcribedAt: number; firstDeltaAt: number; firstSentenceAt: number; synthesisMs: number; worker?: WorkerTimes;
    /** 18.4.1 the stream from the first request after the round opened to the first word */
    requestedAt: number; spoke: boolean; agent: AgentTimes;
    /** the thinking: exact for the messages that ended, estimated for the one that runs; `counted` once either came */
    thinking: { exact: number; estimate: number; counted: boolean; done: boolean };
  } | null = null;
  private readonly rounds: Round[] = [];
  /**
   * 18.6 every barge-in, with the sound that caused it. The two thresholds are
   * a guess until a drive says otherwise, and a barge-in that turned out to be
   * nothing is the one that cost a sentence for no reason.
   */
  private readonly bargeIns: Array<{ level: number; heldMs: number; as: Outcome | null }> = [];

  /**
   * Chris stopped talking. `endedAt` is when he stopped and `noticedAt` is when
   * the bridge could tell, which is the quiet that ended the utterance later.
   * Both are needed: the total has to run from when he stopped, and the
   * engine's share must not be charged for a wait that a setting decides.
   */
  speechEnded(endedAt: number, noticedAt = Date.now()): void {
    this.open = { endedAt, noticedAt, transcribedAt: 0, firstDeltaAt: 0, firstSentenceAt: 0, synthesisMs: 0, requestedAt: 0, spoke: false, agent: {}, thinking: { exact: 0, estimate: 0, counted: false, done: false } };
  }

  /** The recording is text. */
  transcribed(at = Date.now()): void {
    if (this.open && !this.open.transcribedAt) this.open.transcribedAt = at;
  }

  /** The agent's first word of the answer arrived. */
  firstDelta(at = Date.now()): void {
    if (this.open && !this.open.firstDeltaAt) this.open.firstDeltaAt = at;
  }

  /**
   * 18.4.1 an event of the agent's stream. Only the stream from the first
   * request after the round opened to the first word counts, and the end of
   * the message that holds the first word, which gives its exact thinking.
   */
  agent(event: Event, at = Date.now()): void {
    const open = this.open;
    if (!open || open.thinking.done) return;
    if (!open.requestedAt) {
      if (event.kind === "requesting") open.requestedAt = at;
      return;
    }
    const thinking = open.thinking;
    if (event.kind === "messageEnd") {
      thinking.exact += event.thinkingTokens;
      thinking.estimate = 0;
      thinking.counted = true;
      thinking.done = open.spoke;
      return;
    }
    if (open.spoke) return;
    const times = open.agent;
    switch (event.kind) {
      case "messageStart":
        if (times.toolsBeforeText !== undefined) break;
        times.inputTokens = event.usage.inputTokens;
        times.cacheReadTokens = event.usage.cacheReadTokens;
        times.cacheCreationTokens = event.usage.cacheCreationTokens;
        times.requestMs = at - open.requestedAt;
        times.toolsBeforeText = 0;
        break;
      case "thinking": thinking.estimate += event.tokens; thinking.counted = true; break;
      case "blockStart":
        times.firstEvent ??= event.type;
        if (event.type === "tool_use") times.toolsBeforeText = (times.toolsBeforeText ?? 0) + 1;
        break;
      case "delta": open.spoke = true; break;
      default: break;
    }
  }

  /** The first whole sentence of the answer left the collector. */
  firstSentence(at = Date.now()): void {
    if (this.open && !this.open.firstSentenceAt) this.open.firstSentenceAt = at;
  }

  /** What the engine spent on the sentence that will close this round, and what its worker says it spent. */
  synthesized(ms: number, worker?: WorkerTimes): void {
    if (!this.open || this.open.synthesisMs) return;
    this.open.synthesisMs = Math.round(ms);
    this.open.worker = worker;
  }

  /**
   * The first audio of the answer is on its way. Later sentences are not a
   * round. Returns the round it closed, or null when it closed none: a caller
   * that records rounds must not record the one before this again.
   */
  answered(at = Date.now()): TimedRound | null {
    const open = this.open;
    if (!open) return null;
    this.open = null;
    const asked = open.transcribedAt || open.noticedAt;
    const round: TimedRound = {
      pauseMs: open.noticedAt - open.endedAt,
      transcribeMs: open.transcribedAt ? open.transcribedAt - open.noticedAt : 0,
      answerMs: at - open.endedAt,
      agentMs: open.firstDeltaAt ? open.firstDeltaAt - asked : 0,
      sentenceMs: open.firstDeltaAt && open.firstSentenceAt ? open.firstSentenceAt - open.firstDeltaAt : 0,
      synthesisMs: open.synthesisMs,
      ...open.worker,
      ...open.agent,
      ...(open.thinking.counted ? { thinkingTokens: open.thinking.exact + open.thinking.estimate } : {}),
    };
    this.rounds.push(round);
    if (this.rounds.length > KEEP) this.rounds.shift();
    return round;
  }

  /** 11.3 the playback stopped. `level` is the loudest frame that did it. */
  barged(level: number, heldMs: number): void {
    this.bargeIns.push({ level, heldMs, as: null });
    if (this.bargeIns.length > KEEP) this.bargeIns.shift();
  }

  /** What the utterance behind the last barge-in turned out to be. */
  resolved(as: Outcome): void {
    const last = this.bargeIns[this.bargeIns.length - 1];
    if (last && last.as === null) last.as = as;
  }

  get bargeInCount(): number { return this.bargeIns.length; }

  /** The ones that cost a sentence and carried nothing. */
  get falseBargeIns(): number {
    return this.bargeIns.filter((one) => one.as === "nothing").length;
  }

  get count(): number { return this.rounds.length; }

  get last(): Round | null { return this.rounds[this.rounds.length - 1] ?? null; }

  /** The middle of the recent rounds, which a mean would hide behind one bad tunnel. */
  median(): number {
    if (this.rounds.length === 0) return 0;
    const sorted = this.rounds.map((round) => round.answerMs).sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? (sorted[middle] as number) : (((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2);
  }

  worst(): number {
    return this.rounds.reduce((worst, round) => Math.max(worst, round.answerMs), 0);
  }

  /** 9.4 spoken, so it has to be sentences a person can hear once and keep. */
  report(): string {
    const last = this.last;
    if (!last) return "No round trip has been measured yet.";
    // One sentence of all of this ran fourteen seconds on a real run, which is
    // a long time to be talked at in a car. Short sentences, and the ones a
    // person is least likely to want come last.
    const parts = [`Last answer, ${seconds(last.answerMs)} seconds.`];
    if (this.rounds.length > 1) parts.push(`Median ${seconds(this.median())}, worst ${seconds(this.worst())}.`);
    parts.push(`${seconds(last.pauseMs)} of it was the end of turn pause.`);
    // the split, when the marks were made: a command's reply has none
    if (last.agentMs > 0) parts.push(`The agent took ${seconds(last.agentMs)}, the first sentence ${seconds(last.sentenceMs)}, the voice ${seconds(last.synthesisMs)}.`);
    if (this.bargeIns.length > 0) {
      parts.push(`${this.bargeIns.length} barge-ins, ${this.falseBargeIns} of them nothing.`);
    }
    return parts.join(" ");
  }
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}
