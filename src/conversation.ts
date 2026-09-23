/**
 * What the bridge does with a thing Chris said, whatever carried it.
 *
 * The desk loop of 7.3 and the LiveKit room of 7.4 differ only in how audio
 * arrives and how it leaves. Everything above that — the turn, the sentences,
 * the wake commands, the checkpoint, the memory of what was said — is the same,
 * so it lives here and each transport supplies the two ends.
 *
 * A barge-in stops the speech and *holds* it (11.3); the mouth does the
 * holding. What Chris said then decides what becomes of the held sentences,
 * and only two commands touch the agent at all:
 *
 * | what Chris said | the held speech | the turn |
 * |---|---|---|
 * | mute, unmute, tones, music | resumes after the acknowledgement | untouched |
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
 * | end the turn | dropped, a replay too | interrupted |
 * | clear the context | held until the gate answers | dies with the process |
 */
import type { Channel } from "./channel.ts";
import { commandIn, match, type CommandName } from "./commands.ts";
import type { Config } from "./config.ts";
import type { CueName } from "./cues.ts";
import { echoOf } from "./echo.ts";
import type { Ears } from "./ear.ts";
import type { Measures } from "./measures.ts";
import type { Mouth } from "./mouth.ts";
import { Network } from "./network.ts";
import { LongMarker, SentenceCollector, withoutMarker } from "./sentences.ts";
import { Session, type SessionHooks, type Turn } from "./session.ts";

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

export interface ConversationHooks {
  onTurn?(turn: Turn): void;
  /** 9.4 a setting Chris changed out loud, for whoever keeps settings. */
  onSetting?(patch: Partial<Config>): void;
  /** 11.12 the audio went on or off by voice, so every client can be told. */
  onAudio?(): void;
}

export class Conversation {
  private muted = false;
  private tones: boolean;
  private holdMusic: boolean;
  private turnRunning = false;
  private checkpointOpen = false;
  private lastReply = "";
  /**
   * 11.9 whether a question that lands mid-answer stops the answer or is
   * refused. A setting, and a wake command, because only a drive says which is
   * right and a restart to change it costs the session.
   */
  private interrupting: boolean;
  /**
   * The turn in flight, and which turn that is. An interrupted turn goes on
   * running until its process returns a result, and it must not speak, record
   * or clear anything by the time it does.
   */
  private running: Promise<void> | null = null;
  private turnId = 0;
  /**
   * 9.1 the wake word arrived on its own. Chris leaves about 1.6 seconds
   * before the command, which is longer than the end-of-turn pause, so the two
   * become separate utterances: "sidetone" then "mute", and neither works.
   * Rather than asking him to say it again, wait and read the next utterance
   * as the command.
   */
  private awaitingCommand = 0;
  /** 10.1 an action waiting for the agreement word before it happens. */
  private gate: { act(): void; denied: string; timer: ReturnType<typeof setTimeout> } | null = null;
  /** 9.4.7 the last three request and reply pairs, which the bridge answers from itself */
  private readonly recent: Array<{ said: string; reply: string }> = [];

  readonly agent: Agent;
  /** 18.4 the round trip, which the mouth marks and the stats command reads. */
  readonly measures: Measures;
  /** N.1 what the connection is doing, which the transport feeds and stats reads. */
  readonly network = new Network();

  constructor(
    dir: string,
    private readonly config: Config,
    /** what the bridge says, from a sentence to the sound of it, in whichever voice */
    private readonly mouth: Mouth,
    /** 4.3 what the client is told, and what a returning one is owed */
    private readonly channel: Channel,
    hooks: ConversationHooks = {},
    makeAgent: MakeAgent = claudeCode(dir),
  ) {
    this.measures = mouth.measures;
    // 6.5 the voice instruction lives in the bridge, not in the agent's identity file
    const args = [...config.claudeArgs, "--append-system-prompt", config.voiceInstruction];
    this.agent = makeAgent({
      onDelta: (text) => this.answering?.delta(text),
      onBlockStart: (type) => this.answering?.blockStart(type),
      onBlockEnd: () => this.answering?.blockEnd(),
      onNarration: (text) => this.channel.narrate(text),
      // 8.6.3 speak, say how long it has run, and report the usage with the ask (8.6.4)
      onCheckpoint: (ms) => {
        this.checkpointOpen = true;
        this.reply(`This turn has run ${Math.round(ms / 60_000)} minutes and cost ${this.agent.totalCostUsd().toFixed(2)} dollars. Say ${config.agreementWord} to let it run on.`);
      },
      onInterrupt: () => { this.checkpointOpen = false; },
      onUnprompted: (turn) => this.unprompted(turn),
      onRestart: () => this.cue("starting"),
    }, { ...config, claudeArgs: args });
    this.tones = config.tones;
    this.holdMusic = config.holdMusic;
    this.interrupting = config.interruptOnSpeech;
    const self = this;
    this.ears = {
      get isMuted() { return self.muted; },
      cue: (name) => this.cue(name),
      stopSpeaking: () => this.mouth.hold(),
      heard: (text) => this.heard(text),
      heardNothing: () => this.heardNothing(),
    };
    this.onTurn = hooks.onTurn;
    this.onSetting = hooks.onSetting;
    this.onAudio = hooks.onAudio;
  }

  private onTurn?: (turn: Turn) => void;
  private onSetting?: (patch: Partial<Config>) => void;
  private onAudio?: () => void;
  /** Where the agent's words and blocks go while a turn of ours runs; null between turns. */
  private answering: { delta(text: string): void; blockStart(type: string): void; blockEnd(): void } | null = null;

  get busy(): boolean { return this.turnRunning; }
  get waitingForAgreement(): boolean { return this.checkpointOpen; }
  get isMuted(): boolean { return this.muted; }
  /** 15.4 whether the cues are on, for a transport that plays one of its own. */
  get tonesOn(): boolean { return this.tones; }
  /** 15.7.3 whether the hold music may play. */
  get musicOn(): boolean { return this.holdMusic; }

  /**
   * What the ear tells, in the modules that own it. A barge-in holds the
   * mouth (11.3); the words, and the news that there were none, come here.
   * Four one-line forwards used to stand in for this object.
   */
  readonly ears: Ears;

  /** Every cue goes through here, so one command can silence all of them (15.4). */
  cue(name: CueName): void {
    if (this.tones) this.mouth.cue(name);
  }

  /** One sentence of the answer. It is what a barge-in holds. */
  private speak(text: string, answer?: number): void {
    this.mouth.say(text, answer);
  }

  /** One sentence from the bridge itself. It jumps a hold, because you asked now. */
  private reply(text: string): void {
    this.mouth.reply(text);
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
    // the turn is no longer the one that owns the mouth, whatever becomes of it
    this.turnId++;
    const unspoken = this.mouth.discard().join(" ");
    // 11.10 the bubbles already hold these words, so they are recorded and not shown again
    if (unspoken) this.channel.journal(`not spoken: ${unspoken}`);
    const last = this.mouth.said.at(-1);
    const running = (this.running ?? Promise.resolve()).then(() => true, () => true);
    // Give it a moment to end by itself. An interrupt is what costs a subagent,
    // and the voice is already silent, so waiting is free to listen to.
    const waitStart = Date.now();
    const ended = await Promise.race([running, Bun.sleep(this.config.interruptAfterMs).then(() => false)]);
    this.measures.cutOff(Date.now() - waitStart, !ended);
    if (!ended) {
      this.agent.interrupt();
      await Promise.race([running, Bun.sleep(this.config.graceMs)]);
    }
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
    this.mouth.resume();
  }

  /** One thing Chris said, and what it does to a held answer. */
  async heard(said: string): Promise<void> {
    // 18.10 an utterance that repeats what the voice just said is the room, not
    // Chris: the phone's echo canceller let the speaker through. It is recorded
    // rather than acted on, because a person may read a sentence back.
    const echoed = echoOf(said, this.mouth.lastSpoken);
    if (echoed) {
      this.measures.echo(said, echoed);
      this.channel.journal(`the bridge may have heard itself: "${said}" repeats "${echoed}"`);
    }
    const heard = match(said, this.config.wakeWord, this.muted, this.config.mutedCommands, this.config.wakeWordVariants);
    this.channel.tell({ kind: "heard", text: said });
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
        this.measures.matched(said, name);
        this.after(await this.run(name));
        return;
      }
    }

    if (heard.kind === "command") {
      this.measures.matched(said, heard.name);
      this.after(await this.run(heard.name));
      return;
    }
    // 9.7 the wake word came through and the command did not. Wait for it
    // rather than complaining: the pause between the two is usually the reason.
    if (heard.kind === "unclear") {
      this.measures.matched(said, "waiting for the command");
      // Holding for the command and saying nothing is right. Saying nothing
      // anywhere is not: on 18 September the agent told Chris four times to put
      // the wake word in front of a sentence, and neither end could see why.
      this.channel.narrate(`the wake word arrived with no command, so nothing was done with: "${said}"`);
      this.awaitingCommand = Date.now() + this.config.wakeHoldMs;
      this.mouth.resume();
      return;
    }
    if (this.muted) { this.mouth.resume(); return; }
    // 10.2 the agreement word is a word said plainly, not a wake command
    if (this.agreed(said)) {
      if (this.gate) { const act = this.gate.act; this.closeGate(); act(); this.mouth.discard(); return; }
      if (this.checkpointOpen) {
        this.checkpointOpen = false;
        this.agent.agree();
        this.reply("Carrying on.");
        this.mouth.resume();
        return;
      }
    }
    // 15.1 a question that arrives mid-turn must not vanish into silence
    if (this.turnRunning) {
      if (!this.interrupting) {
        this.reply(`I am still on the last one. Say ${this.config.wakeWord}, end the turn, to stop it.`);
        this.mouth.resume();
        return;
      }
      // 11.6 and 11.9 the Claude app's feel: the answer stops and the question
      // is the next turn, with no phrase to say first.
      this.measures.matched(said, "speech");
      void this.turn(said, await this.cutOff());
      return;
    }
    this.measures.matched(said, "speech");
    this.mouth.discard();
    void this.turn(said);
  }

  private after(hold: Hold): void {
    if (hold === "resume") this.mouth.resume();
    if (hold === "discard") this.mouth.discard();
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
      timer: setTimeout(() => { this.gate = null; this.reply(denied); this.mouth.resume(); }, this.config.checkpointWindowMs),
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
    this.mouth.newTurn();
    const sentences = new SentenceCollector(this.config.sentenceMaxChars);
    let firstDelta = true;
    // 14.7 a sentence reaches the client as soon as it is known, which is
    // before the voice reaches it: asked for on the drive of 18 September,
    // when the words arrived only after the whole answer had been spoken.
    const say = (sentence: string) => { this.channel.tell({ kind: "sentence", text: sentence, answer: id }); this.speak(sentence, id); };
    // 14.9 the blocks of this answer that hold text, counted here: the stream's index restarts with each message
    let block = 0;
    let open = false;
    // 15.7.4 the marker is taken off before the words go anywhere
    const marker = new LongMarker();
    const words = (text: string) => {
      if (!text) return;
      // 14.9 the words reach the client before the sentence that finishes with them
      this.channel.tell({ kind: "delta", text, answer: id, block });
      for (const sentence of sentences.push(text)) say(sentence);
    };
    this.answering = {
      delta: (text) => {
        if (!mine()) return;
        // 18.4 the agent's share ends with its first word
        if (firstDelta) { firstDelta = false; this.measures.firstDelta(); }
        words(marker.push(text));
      },
      blockStart: (type) => {
        if (!mine()) return;
        // 15.7.5 a tool call is proof enough that the turn is long, marker or not
        if (type === "tool_use") { words(marker.end()); marker.long = true; }
        if (type !== "text") return;
        open = true;
        this.channel.tell({ kind: "blockStart", answer: id, block: ++block });
      },
      blockEnd: () => {
        if (!mine() || !open) return;
        open = false;
        this.channel.tell({ kind: "blockEnd", answer: id, block });
      },
    };
    const stopCue = this.cueWhileWaiting();
    const stopMusic = this.musicWhileWaiting(mine, () => marker.long);
    try {
      const answer = await this.agent.ask(note ? `${note}\n\n${said}` : said);
      if (!mine()) return;
      const turn = { ...answer, text: withoutMarker(answer.text) };
      words(marker.end());
      const tail = sentences.flush();
      if (tail) say(tail);
      await this.mouth.drained();
      this.lastReply = this.mouth.said.join(" ") || turn.text;
      this.recent.push({ said, reply: this.lastReply });
      if (this.recent.length > 3) this.recent.shift();
      this.channel.tell({ kind: "turn", number: turn.number, text: this.lastReply, costUsd: this.agent.totalCostUsd(), answer: id });
      this.onTurn?.(turn);
      // 13.2 the warning uses the number claude reports, never an estimate (16.6)
      const worst = Math.max(this.agent.rateLimit.fiveHour, this.agent.rateLimit.sevenDay);
      if (worst >= this.config.usageWarnFraction) this.reply(`A heads up: rate limit use is at ${Math.round(worst * 100)} percent.`);
    } catch (error) {
      if (!mine()) return;
      this.reply("That turn did not finish.");
      this.channel.tell({ kind: "error", text: (error as Error).message });
    } finally {
      stopCue();
      stopMusic();
      if (mine()) {
        this.answering = null;
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
   * 15.7 hold music. The agent decides ahead of time (15.7.4): a reply that
   * starts with the marker `[long]` makes the turn a long turn, and only a
   * long turn gets music. A turn with no marker gets none, unless it calls a
   * tool (15.7.5): a tool call is proof enough on its own, so a turn is long
   * the moment one starts, marker or not. `long` is read on every look,
   * because the marker arrives with the first words, after the hand-over.
   *
   * In a long turn the bridge measures the silence: once the room has heard no
   * bridge voice for `holdMusicAfterMs`, the track plays. The silence runs from
   * the later of the hand-over to the agent and the end of the last sentence.
   *
   * It plays once per silent stretch. A sentence starts a new stretch, and a
   * stretch that has had its track waits for one. It stops with the turn, when
   * the turn is no longer the mouth's, and where `Mouth.music` stops it.
   *
   * 15.7.3 `holdMusic` is read on every look, not once: "music on" in the
   * middle of a turn starts the music, and "music off" ends it.
   */
  private musicWhileWaiting(mine: () => boolean, long: () => boolean): () => void {
    const after = this.config.holdMusicAfterMs;
    if (!(after > 0)) return () => {};
    const startedAt = Date.now();
    let over = false;
    let played = 0;
    let timer: ReturnType<typeof setTimeout>;
    const check = async (): Promise<void> => {
      const since = Math.max(startedAt, this.mouth.lastVoiceAt);
      const wait = since + after - Date.now();
      // not silent long enough yet, or this stretch has had its track: look again then
      let next = wait > 0 ? wait : after;
      // 15.11 not while an answer is wanted, or while the bridge is muted; 15.7.3 nor while the music is off; 15.7.4 nor in a turn that is not long
      const wanted = this.checkpointOpen || this.gate !== null || this.muted || !this.holdMusic || !long();
      if (wait <= 0 && played !== since && !wanted) {
        // refused: a cue or a sentence is on the source, so ask again soon
        if (await this.mouth.music(() => over || !mine() || !this.holdMusic)) played = since;
        else next = Math.min(after, 1_000);
      }
      if (!over) timer = setTimeout(check, next);
    };
    timer = setTimeout(check, after);
    return () => { over = true; clearTimeout(timer); };
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
      case "tones": return this.setTones(!this.tones);
      case "tonesOn": return this.setTones(true);
      case "tonesOff": return this.setTones(false);
      // 15.7.3 the hold music is the other sound Chris may not want in the car
      case "musicOn": return this.setHoldMusic(true);
      case "musicOff": return this.setHoldMusic(false);
      /**
       * 11.12 the audio, which the app also has a button for. With it off the
       * bridge looks dead from the car, so the way back has to be something
       * that can be said: the microphone is still listening either way.
       */
      case "audioOn": return this.setAudio(true);
      case "audioOff": return this.setAudio(false);

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
        const missed = this.turnRunning ? this.mouth.said.at(-1) : this.lastReply;
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
      case "carryOn":
        if (!this.mouth.carryOn()) this.reply("There is nothing left of it.");
        return "resume";

      case "interrupt": return this.setInterrupting(!this.interrupting);
      case "interruptOn": return this.setInterrupting(true);
      case "interruptOff": return this.setInterrupting(false);

      case "endTurn":
        // no turn, but a replay from "carry on" may be playing, and it stops too
        if (!this.turnRunning) {
          if (!this.mouth.busy) { this.reply("Nothing is running."); return "resume"; }
          this.reply("Stopped.");
          return "discard";
        }
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

  /**
   * 11.11 a turn nobody asked for, spoken.
   *
   * A background job that finishes hands Claude Code a task notification, and
   * it answers: measured 18 September, four such turns across three runs, every
   * word of them dropped. They go through `reply`, which jumps a hold, because
   * what they carry is news and the answer they land on is not.
   */
  private unprompted(turn: Turn): void {
    if (turn.isError) return;
    const text = withoutMarker(turn.text.trim());
    if (!text) return;
    const sentences = new SentenceCollector(this.config.sentenceMaxChars);
    for (const sentence of sentences.push(text)) this.reply(sentence);
    const last = sentences.flush();
    if (last) this.reply(last);
    this.channel.tell({ kind: "turn", number: turn.number, text, costUsd: this.agent.totalCostUsd() });
  }

  /** 9.4 the two voices Chris switches between out loud; the mouth owns which. */
  private switchVoice(which: "female" | "male"): Hold {
    const { said, voice } = this.mouth.switchVoice(which);
    if (voice) this.onSetting?.({ ttsVoice: voice });
    this.reply(said);
    return "resume";
  }

  /**
   * 11.12 the audio on or off. On, the voice says so; off, nothing could be
   * heard anyway, so the client is told and the journal says it.
   */
  private setAudio(on: boolean): Hold {
    if (on) {
      this.mouth.setAudio(true);
      this.reply("Audio on.");
    } else {
      // the last thing heard should say why it went quiet, so the line is said
      // first and the audio goes off behind it
      this.reply("Audio off.");
      void this.mouth.drained().then(() => this.mouth.setAudio(false));
      this.channel.journal("the audio is off; the words carry on in the transcript");
    }
    this.onAudio?.();
    return "resume";
  }

  private setTones(on: boolean): Hold {
    this.tones = on;
    this.onSetting?.({ tones: on });
    this.reply(on ? "Tones on." : "Tones off.");
    return "resume";
  }

  /**
   * 15.7.3 the hold music on or off, kept across restarts. The app's music
   * button (17.10) sets it with no answer, as the audio button does.
   */
  setMusic(on: boolean): void {
    this.holdMusic = on;
    this.onSetting?.({ holdMusic: on });
  }

  private setHoldMusic(on: boolean): Hold {
    this.setMusic(on);
    this.reply(on ? "Music on." : "Music off.");
    return "resume";
  }

  /**
   * 11.9 which of the two things a question mid-answer does. Said out loud
   * because the answer is a matter of taste and the car is where it is found,
   * and kept, because a restart that forgot it looked like the fault under test.
   */
  private setInterrupting(on: boolean): Hold {
    this.interrupting = on;
    this.onSetting?.({ interruptOnSpeech: on });
    this.reply(on ? "Interrupting on." : "Interrupting off.");
    return "resume";
  }

  /**
   * 9.4.9 a setting a client changed. It goes through the same paths a spoken
   * command does, the voice's answer included, so tapping a switch and saying
   * the words cannot end anywhere different. A key it does not know is ignored:
   * a client may not reach the settings the car has no command for.
   */
  set(patch: Record<string, unknown>): void {
    if (typeof patch.tones === "boolean") this.setTones(patch.tones);
    if (typeof patch.holdMusic === "boolean") this.setHoldMusic(patch.holdMusic);
    if (typeof patch.interruptOnSpeech === "boolean") this.setInterrupting(patch.interruptOnSpeech);
    if (patch.voice === "female" || patch.voice === "male") this.switchVoice(patch.voice);
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
