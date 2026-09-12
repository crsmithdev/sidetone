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
 * | a question for the agent | dropped | a new turn |
 * | end the turn | dropped | interrupted |
 * | clear the context | held until the gate answers | dies with the process |
 */
import { match, type CommandName } from "./commands.ts";
import type { Config } from "./config.ts";
import type { CueName } from "./cues.ts";
import { Latency } from "./latency.ts";
import { SentenceCollector } from "./sentences.ts";
import { Session, type Turn } from "./session.ts";
import type { SpeechToText, TextToSpeech } from "./speech.ts";

export type { CueName };

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
  private holdBackstop: ReturnType<typeof setTimeout> | null = null;
  /** What has actually reached Chris's ears this turn, for 9.4.5. */
  private said: string[] = [];
  /** 10.1 an action waiting for the agreement word before it happens. */
  private gate: { act(): void; denied: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** 9.4.7 the last three request and reply pairs, which the bridge answers from itself */
  private readonly recent: Array<{ said: string; reply: string }> = [];
  /** 14.7 the light transcript, which 14.8 replays to a client that just arrived */
  private readonly transcript: Array<Record<string, unknown>> = [];

  readonly session: Session;
  /** 18.4 the round trip, which the transport marks and the stats command reads. */
  readonly latency = new Latency();

  constructor(
    dir: string,
    private readonly config: Config,
    private readonly mouth: Mouth,
    private readonly stt: SpeechToText,
    private readonly tts: TextToSpeech,
    hooks: ConversationHooks = {},
  ) {
    // 6.5 the voice instruction lives in the bridge, not in the agent's identity file
    const args = [...config.claudeArgs, "--append-system-prompt", config.voiceInstruction];
    this.session = new Session(dir, { ...config, claudeArgs: args }, {
      onDelta: (text) => this.deltaSink?.(text),
      onNarration: (text) => hooks.onNarration?.(text),
      // 8.6.3 speak, say how long it has run, and report the usage with the ask (8.6.4)
      onCheckpoint: (ms) => {
        this.checkpointOpen = true;
        this.reply(`This turn has run ${Math.round(ms / 60_000)} minutes and cost ${this.session.totalCostUsd().toFixed(2)} dollars. Say ${config.agreementWord} to let it run on.`);
      },
      onInterrupt: () => { this.checkpointOpen = false; },
      onRestart: () => this.cue("starting"),
    });
    this.tones = config.tones;
    this.onTurn = hooks.onTurn;
  }

  private onTurn?: (turn: Turn) => void;
  private deltaSink: ((text: string) => void) | null = null;

  get busy(): boolean { return this.turnRunning; }
  get waitingForAgreement(): boolean { return this.checkpointOpen; }
  get isMuted(): boolean { return this.muted; }
  /** 15.4 whether the cues are on, for a transport that plays one of its own. */
  get tonesOn(): boolean { return this.tones; }
  /** 11.3 whether an answer is waiting to find out what Chris just said. */
  get onHold(): boolean { return this.holding; }

  /** Every cue goes through here, so one command can silence all of them. */
  cue(name: CueName): void {
    if (this.tones) this.mouth.cue(name);
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
        const text = this.ahead.shift() ?? (this.holding ? undefined : this.outbox.shift());
        if (text === undefined) break;
        this.speaking = true;
        let whole = true;
        try { whole = await this.mouth.say(text); }
        catch { /* a transport that dropped is not this loop's problem */ }
        finally { this.speaking = false; }
        // A sentence a barge-in cut is not a sentence Chris heard. It goes back
        // to the front of the hold, so a resume starts it again rather than
        // carrying on from the middle of a word.
        if (whole === false && this.holding) this.outbox.unshift(text);
        else this.said.push(text);
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

  /** What Chris said replaces the answer: everything still queued goes. */
  discardHold(): void {
    this.clearBackstop();
    this.holding = false;
    this.outbox.length = 0;
    this.settleIfIdle();
  }

  /** The utterance held nothing a person said. Road noise must not cost a passage. */
  heardNothing(): void {
    this.latency.resolved("nothing");
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
    this.latency.resolved(heard.kind === "command" ? "command" : "speech");

    // 10.5 the gate fails closed: anything that is not the agreement word
    // cancels the action, and is then handled as what it was.
    if (this.gate && !this.agreed(said)) {
      const denied = this.gate.denied;
      this.closeGate();
      this.reply(denied);
    }

    if (heard.kind === "command") { this.after(await this.run(heard.name)); return; }
    // 9.7 the wake word came through and the command did not
    if (heard.kind === "unclear") { this.reply("Say the command again."); this.resumeHold(); return; }
    if (this.muted) { this.resumeHold(); return; }
    // 10.2 the agreement word is a word said plainly, not a wake command
    if (this.agreed(said)) {
      if (this.gate) { const act = this.gate.act; this.closeGate(); act(); this.discardHold(); return; }
      if (this.checkpointOpen) {
        this.checkpointOpen = false;
        this.session.agree();
        this.reply("Carrying on.");
        this.resumeHold();
        return;
      }
    }
    // 15.1 a question that arrives mid-turn must not vanish into silence
    if (this.turnRunning) {
      this.reply(`I am still on the last one. Say ${this.config.wakeWord}, end the turn, to stop it.`);
      this.resumeHold();
      return;
    }
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
  async turn(said: string): Promise<void> {
    this.turnRunning = true;
    this.said = [];
    const sentences = new SentenceCollector(this.config.sentenceMaxChars);
    this.deltaSink = (text) => {
      for (const sentence of sentences.push(text)) this.speak(sentence);
    };
    const stopCue = this.cueWhileWaiting();
    try {
      const turn = await this.session.ask(said);
      const tail = sentences.flush();
      if (tail) this.speak(tail);
      await this.drained();
      this.lastReply = this.said.join(" ") || turn.text;
      this.recent.push({ said, reply: this.lastReply });
      if (this.recent.length > 3) this.recent.shift();
      this.remember({ kind: "turn", number: turn.number, text: this.lastReply, costUsd: this.session.totalCostUsd() });
      this.onTurn?.(turn);
      // 13.2 the warning uses the number claude reports, never an estimate (16.6)
      const worst = Math.max(this.session.rateLimit.fiveHour, this.session.rateLimit.sevenDay);
      if (worst >= this.config.usageWarnFraction) this.reply(`A heads up: rate limit use is at ${Math.round(worst * 100)} percent.`);
    } catch (error) {
      this.reply("That turn did not finish.");
      this.mouth.tell?.({ kind: "error", text: (error as Error).message });
    } finally {
      stopCue();
      this.deltaSink = null;
      this.turnRunning = false;
      this.checkpointOpen = false;
    }
  }

  /** 15.1 a wait must not be silence. 15.5 only once the wait is long enough. */
  private cueWhileWaiting(): () => void {
    let timer = setTimeout(function tick(this: Conversation) {
      // 15.1 a cue fills silence. Never over the voice — one transport shares a
      // single audio source and refuses two writers — and never while an answer
      // is wanted, because at the checkpoint the bridge has just asked for one.
      if (!this.checkpointOpen && !this.speaking) this.cue("thinking");
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
        const context = this.session.contextFraction();
        this.reply(`This session has cost ${this.session.totalCostUsd().toFixed(2)} dollars.`);
        const { fiveHour, sevenDay } = this.session.rateLimit;
        if (fiveHour || sevenDay) this.reply(`Rate limit use is ${Math.round(fiveHour * 100)} percent of the five hour window and ${Math.round(sevenDay * 100)} percent of the seven day window.`);
        if (context !== null) this.reply(`The context is ${Math.round(context * 100)} percent of the compaction threshold.`);
        return "resume";
      }
      case "stats": this.reply(this.latency.report()); return "resume";

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

      case "endTurn":
        if (!this.turnRunning) { this.reply("Nothing is running."); return "resume"; }
        this.session.interrupt();
        this.reply("Stopped.");
        return "discard";

      // 8.8 a fresh process is a fresh context. 10.1 gates it: the whole match
      // is the one word "clear", and what it costs is the whole conversation.
      case "clearContext":
        this.askFirst("I am about to clear the context and start again.", "Nothing was cleared.", () => {
          this.session.restart("cleared by voice");
          this.reply("Context cleared.");
        });
        return "keep";
    }
  }

  /** One utterance of PCM becomes one thing Chris said. */
  async transcribe(wavPath: string): Promise<string> {
    return this.stt.transcribe(wavPath);
  }

  synthesize(text: string, wavPath: string): Promise<string> {
    return this.tts.synthesize(text, wavPath);
  }

  start(): void { this.session.start(); }
  stop(): void { this.session.stop(); }
}

function plain(text: string): string {
  return text.toLowerCase().replace(/[^a-z ]/g, "");
}

function firstSentence(text: string): string {
  const at = text.search(/[.!?]\s/);
  return at < 0 ? text : text.slice(0, at + 1);
}
