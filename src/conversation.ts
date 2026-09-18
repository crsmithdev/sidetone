/**
 * What the bridge does with a thing Chris said, whatever carried it.
 *
 * The desk loop of 7.3 and the LiveKit room of 7.4 differ only in how audio
 * arrives and how it leaves. Everything above that — the turn, the sentences,
 * the wake commands, the checkpoint, the memory of what was said — is the same,
 * so it lives here and each transport supplies the two ends.
 *
 * A barge-in stops the speech and *holds* it (11.3). What Chris said then
 * decides what becomes of the held sentences, and only two commands touch the
 * agent at all:
 *
 * | what Chris said | the held speech | the turn |
 * |---|---|---|
 * | mute, unmute, tones | resumes after the acknowledgement | untouched |
 * | usage, stats | resumes after the report | untouched |
 * | say that again | resumes after the repeat | untouched |
 * | the wake word alone, or noise | resumes | untouched |
 * | where are we | dropped | untouched |
 * | summarize, mid-turn | resumes; the command is refused | untouched |
 * | summarize, between turns | dropped | a new turn |
 * | a question for the agent, between turns | dropped | a new turn |
 * | a question for the agent, mid-turn, holding | resumes; the question is refused | untouched |
 * | a question for the agent, mid-turn, interrupting | kept for "carry on" | interrupted, then a new turn |
 * | carry on | the kept rest is said | untouched |
 * | end the turn | dropped | interrupted |
 * | clear the context | held until the gate answers | dies with the process |
 */
import { commandIn, match, type CommandName } from "./commands.ts";
import type { Config } from "./config.ts";
import type { CueName } from "./cues.ts";
import { Measures } from "./measures.ts";
import { Network } from "./network.ts";
import { SentenceCollector } from "./sentences.ts";
import { Session, type SessionHooks, type Turn } from "./session.ts";
import type { TextToSpeech } from "./speech.ts";

export type { CueName };

/**
 * The agent, as the conversation needs it (ADR 0001). `Session` is the one
 * that runs Claude Code; a test gives a scripted one instead, which is the only
 * way a whole turn — deltas, the checkpoint, a restart — can be driven at all.
 */
export interface Agent {
  start(): void;
  stop(): void;
  ask(said: string): Promise<Turn>;
  agree(): void;
  interrupt(): void;
  restart(reason: string): void;
  readonly running: boolean;
  readonly turns: number;
  readonly rateLimit: { fiveHour: number; sevenDay: number };
  contextFraction(): number | null;
  totalCostUsd(): number;
}

/**
 * How an agent is made. The conversation decides what the agent is told about
 * being in a spoken conversation (6.5) and hands the amended settings over; the
 * caller decides what the agent is and where it runs.
 */
export type MakeAgent = (hooks: SessionHooks, config: Config) => Agent;

/** The agent of ADR 0001: one Claude Code process, in the project directory. */
export const claudeCode = (dir: string): MakeAgent => (hooks, config) => new Session(dir, config, hooks);

/** What a command does to the sentences a barge-in held. */
export type Hold = "resume" | "discard" | "keep";

export interface Mouth {
  /** Speak one sentence. False means a barge-in cut it short (11.3). */
  say(text: string): Promise<boolean>;
  /** 15.2 a sound that is not speech, for a wait that has gone on. */
  cue(name: CueName): void;
  /** 4.3 the control channel: the transcript and the turn number (14.5, 14.7). */
  tell?(value: Record<string, unknown>): void;
}

export interface ConversationHooks {
  onNarration?(text: string): void;
  onTurn?(turn: Turn): void;
  /** What the bridge decided a thing Chris said actually was (9.4, 9.7). */
  onMatched?(said: string, became: string): void;
}

export class Conversation {
  private muted = false;
  private tones: boolean;
  private turnRunning = false;
  private checkpointOpen = false;
  private lastReply = "";
  private speaking = false;
  /**
   * The answer, sentence by sentence, and the bridge's own replies. They are
   * two queues because a reply to a command has to be heard *now*, over a held
   * answer: you asked for it in the middle of the answer on purpose.
   */
  private readonly outbox: string[] = [];
  private readonly ahead: string[] = [];
  private pumping = false;
  private waiters: Array<() => void> = [];
  /** 11.3 true from the barge-in until what Chris said is resolved. */
  private holding = false;
  /**
   * 11.9 whether a question that lands mid-answer stops the answer or is
   * refused. A setting, and a wake command, because only a drive says which is
   * right and a restart to change it costs the session.
   */
  private interrupting: boolean;
  /**
   * What an interrupt took off the queue, so "carry on" can say it and the
   * client can show it. Chris never heard these, and the agent's own context
   * holds them as though he did.
   */
  private tail: string[] = [];
  /**
   * The turn in flight, and which turn that is. An interrupted turn goes on
   * running until its process returns a result, and it must not speak, record
   * or clear anything by the time it does.
   */
  private running: Promise<void> | null = null;
  private turnId = 0;
  private holdBackstop: ReturnType<typeof setTimeout> | null = null;
  /** What has actually reached Chris's ears this turn, for 9.4.5. */
  private said: string[] = [];
  /**
   * 9.1 the wake word arrived on its own. Chris leaves about 1.6 seconds
   * before the command, which is longer than the end-of-turn pause, so the two
   * become separate utterances: "hey bridge" then "mute", and neither works.
   * Rather than asking him to say it again, wait and read the next utterance
   * as the command.
   */
  private awaitingCommand = 0;
  /** 10.1 an action waiting for the agreement word before it happens. */
  private gate: { act(): void; denied: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** 9.4.7 the last three request and reply pairs, which the bridge answers from itself */
  private readonly recent: Array<{ said: string; reply: string }> = [];
  /** 14.7 the light transcript, which 14.8 replays to a client that just arrived */
  private readonly transcript: Array<Record<string, unknown>> = [];

  readonly agent: Agent;
  /** 18.4 the round trip, which the transport marks and the stats command reads. */
  readonly measures: Measures;
  /** N.1 what the connection is doing, which the transport feeds and stats reads. */
  readonly network = new Network();

  constructor(
    dir: string,
    private readonly config: Config,
    private readonly mouth: Mouth,
    /** 9.4 the voice commands, which are the only reason this is here */
    private readonly tts: TextToSpeech,
    hooks: ConversationHooks = {},
    makeAgent: MakeAgent = claudeCode(dir),
    measures: Measures = new Measures(),
  ) {
    this.measures = measures;
    // 6.5 the voice instruction lives in the bridge, not in the agent's identity file
    const args = [...config.claudeArgs, "--append-system-prompt", config.voiceInstruction];
    this.agent = makeAgent({
      onDelta: (text) => this.deltaSink?.(text),
      onNarration: (text) => hooks.onNarration?.(text),
      // 8.6.3 speak, say how long it has run, and report the usage with the ask (8.6.4)
      onCheckpoint: (ms) => {
        this.checkpointOpen = true;
        this.reply(`This turn has run ${Math.round(ms / 60_000)} minutes and cost ${this.agent.totalCostUsd().toFixed(2)} dollars. Say ${config.agreementWord} to let it run on.`);
      },
      onInterrupt: () => { this.checkpointOpen = false; },
      onRestart: () => this.cue("starting"),
    }, { ...config, claudeArgs: args });
    this.tones = config.tones;
    this.interrupting = config.interruptOnSpeech;
    this.onTurn = hooks.onTurn;
    this.onMatched = hooks.onMatched;
  }

  private onTurn?: (turn: Turn) => void;
  private onMatched?: (said: string, became: string) => void;
  private deltaSink: ((text: string) => void) | null = null;

  get busy(): boolean { return this.turnRunning; }
  get waitingForAgreement(): boolean { return this.checkpointOpen; }
  get isMuted(): boolean { return this.muted; }
  /** 15.4 whether the cues are on, for a transport that plays one of its own. */
  get tonesOn(): boolean { return this.tones; }
  /** 11.3 whether an answer is waiting to find out what Chris just said. */
  get onHold(): boolean { return this.holding; }

  /**
   * Every cue goes through here, so one command can silence all of them, and
   * so nothing plays a cue over the voice. One transport shares one audio
   * source and refuses a second writer: on 14 September the cue that marks the
   * end of a turn fired while the bridge was mid-sentence and the transport
   * threw `InvalidState - failed to capture frame`. The thinking cue had this
   * guard at its call site; the others did not, so it lives here now.
   */
  cue(name: CueName): void {
    if (this.tones && !this.speaking) this.mouth.cue(name);
  }

  /** One sentence of the answer. It is what a barge-in holds. */
  private speak(text: string): void {
    this.outbox.push(text);
    void this.pump();
  }

  /** One sentence from the bridge itself. It jumps a hold, because you asked now. */
  private reply(text: string): void {
    this.ahead.push(text);
    void this.pump();
  }

  /** Sentences never overlap, and they keep their order (5.7). */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        // which queue it came from, so a cut sentence goes back to that one
        const jumped = this.ahead.length > 0;
        const text = this.ahead.shift() ?? (this.holding ? undefined : this.outbox.shift());
        if (text === undefined) break;
        this.speaking = true;
        let whole = true;
        try { whole = await this.mouth.say(text); }
        catch { /* a transport that dropped is not this loop's problem */ }
        finally { this.speaking = false; }
        // A sentence a barge-in cut is not a sentence Chris heard. It goes back
        // to the front of the queue it came from, so a resume starts it again
        // rather than carrying on from the middle of a word. A bridge reply
        // used to return to the answer queue instead, where the next
        // discardHold dropped it: "Muted." went unsaid.
        //
        // Either way it is not something he heard, so it never joins `said`.
        // Reading `this.holding` after the await asked the wrong question: a
        // discardHold while the sentence was still playing flipped it, and a
        // sentence cut mid-word became the one `restate` read back.
        if (whole === false) {
          if (this.holding) (jumped ? this.ahead : this.outbox).unshift(text);
        } else this.said.push(text);
      }
    } finally {
      this.pumping = false;
      this.settleIfIdle();
    }
  }

  /**
   * 11.3 stop the playback the moment Chris starts to talk — all of it. Cutting
   * only the sentence in flight lets the queue drain into the gap, so the
   * bridge keeps talking and stops each sentence in turn, which sounds worse
   * than not stopping at all.
   *
   * The sentences are kept, not dropped. Until the bridge knows what Chris
   * said it cannot know whether they still matter, and the answer to that is a
   * transcription away — no clock is involved in the ordinary case.
   */
  stopSpeaking(): void {
    if (this.holding) return;
    this.holding = true;
    // The one clock: a transcription that never comes back must not leave the
    // bridge silent with a passage stuck behind it.
    this.holdBackstop = setTimeout(() => this.discardHold(), this.config.holdBackstopMs);
  }

  /** What Chris said does not change the answer: say the rest of it. */
  resumeHold(): void {
    this.clearBackstop();
    if (!this.holding) return;
    this.holding = false;
    void this.pump();
  }

  /**
   * What Chris said replaces the answer: everything still queued goes.
   *
   * It is kept, not dropped. 11.10 says an answer he did not hear is still an
   * answer: "carry on" says it, the client shows it, and the agent is told
   * where he stopped, because its own context has the whole thing.
   */
  discardHold(): void {
    this.clearBackstop();
    this.holding = false;
    if (this.outbox.length > 0) this.tail = this.outbox.splice(0);
    this.settleIfIdle();
  }

  /**
   * 11.9 and 11.10 stop the answer, keep what is left of it, and tell the agent where
   * Chris stopped hearing.
   *
   * The agent's context holds the whole answer whatever the mouth managed to
   * say: measured 18 September, an interrupted agent quoted two paragraphs
   * Chris never heard and denied being interrupted at all. It is told, or every
   * turn after an interrupt argues with him.
   *
   * The wait is for the process, which goes on until it returns a result and
   * refuses a second question until then (`Session.ask`). A process that never
   * returns one is 8.6.7's to restart, not a reason to hold the microphone.
   */
  private async cutOff(): Promise<string> {
    this.turnId++;
    this.agent.interrupt();
    this.discardHold();
    const unspoken = this.tail.join(" ");
    if (unspoken) this.mouth.tell?.({ kind: "narration", text: `not spoken: ${unspoken}` });
    const last = this.said[this.said.length - 1];
    await Promise.race([this.running ?? Promise.resolve(), Bun.sleep(this.config.graceMs)]);
    // Measured 18 September: told only that he did not hear the rest, the agent
    // helpfully said the rest again, which is the one thing an interruption is
    // for not doing. It is told what he heard and what not to do about it.
    const heard = last
      ? `The voice stopped mid-answer, after: "${last}" He did not hear anything after that.`
      : "The voice stopped before he heard any of that answer.";
    return `[From the bridge, not from Chris: ${heard} Do not repeat any of it; he has it on screen and can ask for the rest. Answer what he says next.]`;
  }

  /** The utterance held nothing a person said. Road noise must not cost a passage. */
  heardNothing(): void {
    this.measures.bargeInWas("nothing");
    this.resumeHold();
  }

  private clearBackstop(): void {
    if (this.holdBackstop) { clearTimeout(this.holdBackstop); this.holdBackstop = null; }
  }

  private settleIfIdle(): void {
    if (this.pumping || this.speaking) return;
    if (this.ahead.length > 0 || this.outbox.length > 0) return;
    for (const done of this.waiters.splice(0)) done();
  }

  private async drained(): Promise<void> {
    if (!this.pumping && !this.speaking && this.ahead.length === 0 && this.outbox.length === 0) return;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /** Say it on the control channel and keep it, so 14.8 can say it again. */
  private remember(value: Record<string, unknown>): void {
    this.transcript.push({ ...value, at: Date.now() });
    if (this.transcript.length > 40) this.transcript.shift();
    this.mouth.tell?.(value);
  }

  /**
   * 14.8 what a client missed while it was away — which is a drop in a tunnel,
   * measured in minutes. Replaying an exchange from hours ago is not that: it
   * arrives looking like the conversation in progress, and the reader has no
   * way to tell that they are being shown something they did not say.
   */
  missed(now = Date.now()): Array<Record<string, unknown>> {
    return this.transcript.filter((entry) => now - (entry.at as number) <= this.config.historyMaxAgeMs);
  }

  /** One thing Chris said, and what it does to a held answer. */
  async heard(said: string): Promise<void> {
    const heard = match(said, this.config.wakeWord, this.muted, this.config.mutedCommands, this.config.wakeWordVariants);
    this.remember({ kind: "heard", text: said });
    this.measures.bargeInWas(heard.kind === "command" ? "command" : "speech");

    // 10.5 the gate fails closed: anything that is not the agreement word
    // cancels the action, and is then handled as what it was.
    if (this.gate && !this.agreed(said)) {
      const denied = this.gate.denied;
      this.closeGate();
      this.reply(denied);
    }

    // the wake word arrived a moment ago on its own, so this is its command.
    // If it is not one, it falls through and reaches the agent as speech: a
    // question asked after a false start must not be swallowed.
    const awaited = this.awaitingCommand > Date.now();
    this.awaitingCommand = 0;
    if (awaited && heard.kind === "speech" && isShort(said)) {
      const name = commandIn(plain(said));
      if (name && (!this.muted || this.config.mutedCommands.includes(name))) {
        this.onMatched?.(said, name);
        this.after(await this.run(name));
        return;
      }
    }

    if (heard.kind === "command") {
      this.onMatched?.(said, heard.name);
      this.after(await this.run(heard.name));
      return;
    }
    // 9.7 the wake word came through and the command did not. Wait for it
    // rather than complaining: the pause between the two is usually the reason.
    if (heard.kind === "unclear") {
      this.onMatched?.(said, "waiting for the command");
      this.awaitingCommand = Date.now() + this.config.wakeHoldMs;
      this.resumeHold();
      return;
    }
    if (this.muted) { this.resumeHold(); return; }
    // 10.2 the agreement word is a word said plainly, not a wake command
    if (this.agreed(said)) {
      if (this.gate) { const act = this.gate.act; this.closeGate(); act(); this.discardHold(); return; }
      if (this.checkpointOpen) {
        this.checkpointOpen = false;
        this.agent.agree();
        this.reply("Carrying on.");
        this.resumeHold();
        return;
      }
    }
    // 15.1 a question that arrives mid-turn must not vanish into silence
    if (this.turnRunning) {
      if (!this.interrupting) {
        this.reply(`I am still on the last one. Say ${this.config.wakeWord}, end the turn, to stop it.`);
        this.resumeHold();
        return;
      }
      // 11.6 and 11.9 the Claude app's feel: the answer stops and the question
      // is the next turn, with no phrase to say first.
      this.onMatched?.(said, "speech");
      void this.turn(said, await this.cutOff());
      return;
    }
    this.onMatched?.(said, "speech");
    this.discardHold();
    void this.turn(said);
  }

  private after(hold: Hold): void {
    if (hold === "resume") this.resumeHold();
    if (hold === "discard") this.discardHold();
  }

  /** 10.3 a specific word, so a reflex or a bad transcription cannot say it. */
  private agreed(said: string): boolean {
    return plain(said).includes(this.config.agreementWord.toLowerCase());
  }

  /**
   * 10.1 an action that waits. 10.4 reads back what it is about to do, 10.5
   * fails closed when no clear agreement comes, and the held answer waits with
   * it rather than resuming under the question.
   */
  private askFirst(what: string, denied: string, act: () => void): void {
    this.reply(`${what} Say ${this.config.agreementWord} to let it happen.`);
    this.gate = {
      act,
      denied,
      timer: setTimeout(() => { this.gate = null; this.reply(denied); this.resumeHold(); }, this.config.checkpointWindowMs),
    };
  }

  private closeGate(): void {
    if (!this.gate) return;
    clearTimeout(this.gate.timer);
    this.gate = null;
  }

  /** Not awaited by the caller: the microphone has to stay open through a turn. */
  async turn(said: string, note = ""): Promise<void> {
    const done = this.runTurn(said, note);
    this.running = done;
    await done;
  }

  /**
   * One turn. `note` is for the agent alone and never joins the transcript:
   * 11.10 uses it to say where an interrupt left Chris.
   *
   * An interrupted turn runs on until its process returns a result, and by then
   * a newer turn owns the mouth. `mine` is what keeps the older one from
   * speaking its last sentence into the middle of the new answer, or from
   * clearing the flags the new one just set.
   */
  private async runTurn(said: string, note: string): Promise<void> {
    const id = ++this.turnId;
    const mine = () => id === this.turnId;
    this.turnRunning = true;
    this.said = [];
    const sentences = new SentenceCollector(this.config.sentenceMaxChars);
    this.deltaSink = (text) => {
      if (!mine()) return;
      for (const sentence of sentences.push(text)) this.speak(sentence);
    };
    const stopCue = this.cueWhileWaiting();
    try {
      const turn = await this.agent.ask(note ? `${note}\n\n${said}` : said);
      if (!mine()) return;
      const tail = sentences.flush();
      if (tail) this.speak(tail);
      await this.drained();
      this.lastReply = this.said.join(" ") || turn.text;
      this.recent.push({ said, reply: this.lastReply });
      if (this.recent.length > 3) this.recent.shift();
      this.remember({ kind: "turn", number: turn.number, text: this.lastReply, costUsd: this.agent.totalCostUsd() });
      this.onTurn?.(turn);
      // 13.2 the warning uses the number claude reports, never an estimate (16.6)
      const worst = Math.max(this.agent.rateLimit.fiveHour, this.agent.rateLimit.sevenDay);
      if (worst >= this.config.usageWarnFraction) this.reply(`A heads up: rate limit use is at ${Math.round(worst * 100)} percent.`);
    } catch (error) {
      if (!mine()) return;
      this.reply("That turn did not finish.");
      this.mouth.tell?.({ kind: "error", text: (error as Error).message });
    } finally {
      stopCue();
      if (mine()) {
        this.deltaSink = null;
        this.turnRunning = false;
        this.checkpointOpen = false;
      }
    }
  }

  /** 15.1 a wait must not be silence. 15.5 only once the wait is long enough. */
  private cueWhileWaiting(): () => void {
    let timer = setTimeout(function tick(this: Conversation) {
      // 15.1 a cue fills silence. Never over the voice — one transport shares a
      // single audio source and refuses two writers — and never while an answer
      // is wanted, because at the checkpoint the bridge has just asked for one.
      // 15.1 never while an answer is wanted: at the checkpoint the bridge has
      // just asked for one. cue() keeps it off the voice.
      if (!this.checkpointOpen) this.cue("thinking");
      timer = setTimeout(tick.bind(this), this.config.audioCueEveryMs);
    }.bind(this), this.config.audioCueDelayMs);
    return () => clearTimeout(timer);
  }

  /**
   * 9.4 the commands. Each answers out loud, because silence is ambiguous
   * (15.1), and each says what becomes of a held answer.
   */
  private async run(name: CommandName): Promise<Hold> {
    switch (name) {
      // A setting changed and the answer did not, so the answer carries on.
      case "mute": this.muted = true; this.reply("Muted."); return "resume";
      case "unmute": this.muted = false; this.reply("Listening."); return "resume";
      // 15.4 the cues earn their keep while this is being built and are noise
      // once it works, so which it is stays Chris's to say, out loud.
      case "tones": this.tones = !this.tones; this.reply(this.tones ? "Tones on." : "Tones off."); return "resume";
      case "tonesOn": this.tones = true; this.reply("Tones on."); return "resume";
      case "tonesOff": this.tones = false; this.reply("Tones off."); return "resume";

      // A question about the bridge, not about the work. Report, then carry on.
      case "usage": {
        const context = this.agent.contextFraction();
        this.reply(`This session has cost ${this.agent.totalCostUsd().toFixed(2)} dollars.`);
        const { fiveHour, sevenDay } = this.agent.rateLimit;
        if (fiveHour || sevenDay) this.reply(`Rate limit use is ${Math.round(fiveHour * 100)} percent of the five hour window and ${Math.round(sevenDay * 100)} percent of the seven day window.`);
        if (context !== null) this.reply(`The context is ${Math.round(context * 100)} percent of the compaction threshold.`);
        return "resume";
      }
      // N.2.5 the connection is reported in the same breath as the round trip,
      // because "is it me or the network" is one question, not two.
      case "stats":
        this.reply(this.measures.report());
        this.reply(this.network.report());
        return "resume";

      // 4.9 the voice is a setting, so changing it changes nothing about the
      // answer. The acknowledgement arrives in the new voice, which is the
      // only demonstration worth having.
      case "femaleVoice": return this.switchVoice("female");
      case "maleVoice": return this.switchVoice("male");

      // 9.4.5 you missed something. Mid-answer that is the last sentence said,
      // not the answer before this one, which is what it used to reach for.
      case "restate": {
        const missed = this.turnRunning ? this.said[this.said.length - 1] : this.lastReply;
        this.reply(missed || this.lastReply || "There is nothing to restate yet.");
        return "resume";
      }

      // 9.4.6 a second turn, which the agent refuses while the first one runs.
      case "summarize":
        if (this.turnRunning) {
          this.reply(`I am still on the last one. Say ${this.config.wakeWord}, end the turn, to stop it.`);
          return "resume";
        }
        if (!this.lastReply) { this.reply("There is nothing to summarize yet."); return "resume"; }
        void this.turn("Summarize your last answer in one short spoken sentence.");
        return "discard";

      // 9.4.7 this is for reorienting when something feels wrong. If Chris is
      // reorienting, the passage he stopped is not what he wants back.
      case "where":
        if (this.recent.length === 0) { this.reply("We have not started yet."); return "resume"; }
        for (const pair of this.recent) this.reply(`You asked: ${pair.said} I said: ${firstSentence(pair.reply)}`);
        return "discard";

      // 11.10 the rest of an answer a barge-in took off the queue. The agent is
      // not asked again: these are its own words, already paid for.
      case "carryOn": {
        const rest = this.tail.splice(0);
        if (rest.length === 0) { this.reply("There is nothing left of it."); return "resume"; }
        // ahead of whatever is queued now, not behind it: measured 18 September,
        // the rest of a cut answer arrived after the whole of the next one.
        for (const sentence of rest) this.reply(sentence);
        return "resume";
      }

      // 11.9 which of the two things a question mid-answer does. Said out loud
      // because the answer is a matter of taste and the car is where it is
      // found, and a restart to change it would cost the session.
      case "interrupt":
        this.interrupting = !this.interrupting;
        this.reply(this.interrupting ? "Interrupting on." : "Interrupting off.");
        return "resume";
      case "interruptOn": this.interrupting = true; this.reply("Interrupting on."); return "resume";
      case "interruptOff": this.interrupting = false; this.reply("Interrupting off."); return "resume";

      case "endTurn":
        if (!this.turnRunning) { this.reply("Nothing is running."); return "resume"; }
        this.agent.interrupt();
        this.reply("Stopped.");
        return "discard";

      // 8.8 a fresh process is a fresh context. 10.1 gates it: the whole match
      // is the one word "clear", and what it costs is the whole conversation.
      case "clearContext":
        this.askFirst("I am about to clear the context and start again.", "Nothing was cleared.", () => {
          this.agent.restart("cleared by voice");
          this.reply("Context cleared.");
        });
        return "keep";
    }
  }

  /** 9.4 the two voices Chris switches between out loud. */
  private switchVoice(which: "female" | "male"): Hold {
    const voice = this.config.voiceChoices[which];
    if (!this.tts.use) { this.reply("This engine has only the one voice."); return "resume"; }
    this.tts.use(voice);
    this.reply(`Switched to the ${which} voice.`);
    return "resume";
  }

  /** One utterance of PCM becomes one thing Chris said. */
  start(): void { this.agent.start(); }
  stop(): void { this.agent.stop(); }
}

/**
 * Short enough to be a command and nothing else.
 *
 * Inside the wake-word hold an utterance is matched with no wake word in front
 * of it, and the command table holds bare single words: `stop`, `clear`,
 * `where`, `man`. So "how do I stop the server" ended the turn and the question
 * never reached the agent. Measured 14 September, a command after the wake word
 * is one or two words -- the longest the card asks for is "tones off".
 */
const HOLD_WORDS = 3;

function isShort(said: string): boolean {
  return plain(said).split(" ").filter(Boolean).length <= HOLD_WORDS;
}

function plain(text: string): string {
  return text.toLowerCase().replace(/[^a-z ]/g, "");
}

function firstSentence(text: string): string {
  const at = text.search(/[.!?]\s/);
  return at < 0 ? text : text.slice(0, at + 1);
}
