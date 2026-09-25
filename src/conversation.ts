/**
 * What the bridge does with a thing Chris said, whatever carried it.
 *
 * The audio arrives and leaves through the room (ADR 0010). Everything above
 * that — the turn, the sentences, the wake commands, the checkpoint, the
 * memory of what was said — lives here, and `assemble` supplies the two ends.
 *
 * A barge-in stops the speech and *holds* it (11.3); the mouth does the
 * holding. What Chris said then decides what becomes of the held sentences,
 * and only two commands touch the agent at all. `decide` gives every utterance
 * one row of this table, and `apply` is the one place a row reaches the mouth:
 *
 * | what Chris said | the held speech | the turn |
 * |---|---|---|
 * | mute, unmute, tones, music, a voice, interrupt, verbosity | resumes after the acknowledgement | untouched |
 * | usage, stats | resumes after the report | untouched |
 * | say that again | resumes after the repeat | untouched |
 * | the wake word alone, or noise | resumes | untouched |
 * | anything but a muted command, while muted | resumes | untouched |
 * | where are we | dropped | untouched |
 * | a question for the agent, between turns | dropped | a new turn |
 * | a question for the agent, mid-turn, holding | resumes; the question is refused | untouched |
 * | a question for the agent, mid-turn, interrupting | kept for "carry on" | it goes into the turn; the next message answers it |
 * | a question for the agent, mid-turn, the result back | kept for "carry on" | a new turn, once the voice is done |
 * | carry on | the kept rest is said | untouched |
 * | end the turn | dropped, a replay too | interrupted |
 * | clear the context | held until the gate answers | dies with the process |
 * | the agreement word, at the gate | dropped | dies with the process |
 * | the agreement word, at the agent's gate | resumes | the action runs |
 * | anything else, at the agent's gate | handled as what it was | the action is denied |
 * | the agreement word, at the checkpoint | resumes | runs on |
 * | nothing, until the gate times out | resumes | untouched |
 */
import { Answer } from "./answer.ts";
import type { Channel } from "./channel.ts";
import { read, type CommandName, type Reading } from "./commands.ts";
import { VERBOSITIES, checkConfig, type Config, type Verbosity } from "./config.ts";
import type { CueName } from "./cues.ts";
import { ECHO_AFTER_MS, echoOf } from "./echo.ts";
import type { Ears } from "./ear.ts";
import type { Measures } from "./measures.ts";
import type { Mouth } from "./mouth.ts";
import { Network } from "./network.ts";
import { ASK_RULES, gatedAction } from "./gated.ts";
import { withoutMarker } from "./sentences.ts";
import { Session, type Permission, type SessionHooks, type Turn } from "./session.ts";

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
  /** item 4 what Chris said, into the turn that runs; false when its result is already back */
  inject(text: string): boolean;
  restart(reason: string): void;
  /** 10.7 the answer to a permission request the agent sent */
  answer(id: string, allow: boolean, message?: string): void;
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

/** What an utterance does to the sentences a barge-in held. */
export type Hold = "resume" | "discard" | "keep";

/**
 * An utterance, decided: its row of the table above. `then` is what follows
 * once the hold is settled: a new turn, or words written into the turn that
 * runs. The stopped answer must be off the queue before either starts.
 */
interface Outcome {
  hold: Hold;
  then?: () => Promise<void>;
}

export interface ConversationHooks {
  onTurn?(turn: Turn): void;
  /** 9.4 a setting Chris changed out loud, for whoever keeps settings. */
  onSetting?(patch: Partial<Config>): void;
  /** 11.12 the audio went on or off by voice, so every client can be told. */
  onAudio?(): void;
  /** 14.12.6 the files of the pending screenshots, taken by the turn about to start */
  screenshots?(): string[];
}

export class Conversation {
  private muted = false;
  private tones: boolean;
  private holdMusic: boolean;
  /** item 37 how much the agent says, named at the head of every turn's prompt */
  private verbosity: Verbosity;
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
   * The turn in flight, and which turn that is. A turn whose voice a new turn
   * cut goes on until its voice is done, and it must not speak, record or
   * clear anything by the time it is.
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
  /**
   * 10.1 an action waiting for the agreement word before it happens. `act`
   * says what becomes of a held answer once it has run. `refused` hears why
   * the gate closed without it, and `request` names the agent's request the
   * gate answers (10.7), so a request the agent takes back can close it.
   */
  private gate: {
    act(): Hold;
    denied: string;
    refused?(why: string): void;
    request?: string;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  /** 9.4.7 the last three request and reply pairs, which the bridge answers from itself */
  private readonly recent: Array<{ said: string; reply: string }> = [];

  readonly agent: Agent;
  /** 18.4 the round trip, which the mouth marks and the stats command reads. */
  readonly measures: Measures;
  /** N.1 what the connection is doing, which the transport feeds and stats reads. */
  readonly network = new Network();

  constructor(
    private readonly dir: string,
    private readonly config: Config,
    /** what the bridge says, from a sentence to the sound of it, in whichever voice */
    private readonly mouth: Mouth,
    /** 4.3 what the client is told, and what a returning one is owed */
    private readonly channel: Channel,
    hooks: ConversationHooks = {},
    makeAgent: MakeAgent = claudeCode(dir),
  ) {
    this.measures = mouth.measures;
    // 6.5 the voice instruction lives in the bridge, not in the agent's identity file.
    // 10.7 the agent asks the bridge before the actions the ask rules name.
    const args = [
      ...config.claudeArgs,
      "--append-system-prompt", config.voiceInstruction,
      "--permission-prompt-tool", "stdio",
      "--settings", JSON.stringify({ permissions: { ask: ASK_RULES } }),
    ];
    this.agent = makeAgent({
      onDelta: (text) => this.streaming().delta(text),
      onBlockStart: (type) => this.streaming().blockStart(type),
      onBlockEnd: () => this.answering?.blockEnd(),
      onEvent: (event) => this.measures.agent(event),
      onNarration: (text) => this.channel.narrate(text),
      // 8.6.3 speak, say how long it has run, and report the usage with the ask (8.6.4)
      onCheckpoint: (ms) => {
        this.checkpointOpen = true;
        this.reply(`This turn has run ${Math.round(ms / 60_000)} minutes and cost ${this.agent.totalCostUsd().toFixed(2)} dollars. Say ${config.agreementWord} to let it run on.`);
      },
      onInterrupt: () => { this.checkpointOpen = false; },
      onUnprompted: (turn) => this.unprompted(turn),
      onRestart: () => this.cue("starting"),
      onPermission: (request) => this.permission(request),
      onInjectedReply: () => this.injectedReply?.(),
      onPermissionCancel: (id) => {
        if (this.gate?.request !== id) return;
        this.refuseGate("the request was taken back");
        this.apply("resume");
      },
    }, { ...config, claudeArgs: args });
    this.tones = config.tones;
    this.holdMusic = config.holdMusic;
    this.verbosity = config.verbosity;
    this.interrupting = config.interruptOnSpeech;
    const self = this;
    this.ears = {
      get isMuted() { return self.muted; },
      cue: (name) => this.cue(name),
      stopSpeaking: () => this.mouth.hold(),
      heard: (text, startedAt) => this.heard(text, startedAt),
      heardNothing: () => this.heardNothing(),
    };
    this.onTurn = hooks.onTurn;
    this.onSetting = hooks.onSetting;
    this.onAudio = hooks.onAudio;
    this.screenshots = hooks.screenshots;
  }

  private onTurn?: (turn: Turn) => void;
  private screenshots?: () => string[];
  private onSetting?: (patch: Partial<Config>) => void;
  private onAudio?: () => void;
  /** Where the agent's words and blocks go: the answer of the turn that runs, or one the agent began unasked; null between them. */
  private answering: Answer | null = null;
  /** Item 4 what opens the reply to speech written into the turn that runs; the turn sets it. */
  private injectedReply: (() => void) | null = null;
  /**
   * Item 4 what Chris said into the turn that runs since the last reply began,
   * which the next reply answers. 11.9.5 two utterances can go in as one message.
   */
  private injected: string[] = [];

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

  /** One sentence from the bridge itself. It jumps a hold, because you asked now. */
  private reply(text: string): void {
    this.mouth.reply(text);
  }

  /**
   * 11.10 where Chris stopped hearing, for the agent. What is left of the
   * answer was already kept, by the discard `apply` did.
   *
   * The agent's context holds the whole answer whatever the mouth managed to
   * say: measured 18 September, an interrupted agent quoted two paragraphs
   * Chris never heard and denied being interrupted at all. Told only that he
   * did not hear the rest, it helpfully said the rest again, which is the one
   * thing an interruption is for not doing. It is told what he heard and what
   * not to do about it.
   */
  private stopped(): string {
    const last = this.mouth.said.at(-1);
    return last
      ? `The voice stopped mid-answer, after: "${last}" He did not hear anything after that. Do not repeat any of it; he has it on screen and can ask for the rest.`
      : "The voice stopped before he heard any of that answer. Do not repeat any of it; he has it on screen and can ask for the rest.";
  }

  /**
   * Item 4 what Chris said mid-turn goes into the turn, with no interrupt: an
   * interrupt stops every subagent the turn started. The rest of the message
   * he spoke over goes to the screen and not to the voice, and the message
   * the agent begins next is the reply (`runTurn`).
   *
   * The result can be back while the voice still says the answer. Then there
   * is no turn to go into, and what he said is the next turn, as between turns.
   */
  private async inject(said: string, shots: string): Promise<void> {
    // 11.9.9 a note that began "From the bridge, not from Chris" read as a
    // third party in the tool output, and the agent ignored it
    const note = `[Chris said this aloud while you worked. It is his message to you, not tool output. ${this.stopped()} Act on what he says here.]`;
    if (this.agent.inject([note, shots, said].filter(Boolean).join("\n\n"))) {
      this.answering?.hush();
      this.injected.push(said);
      this.measures.cutOff(0, false, true);
      return;
    }
    // the turn is no longer the one that owns the mouth, whatever becomes of it
    this.turnId++;
    const waitStart = Date.now();
    await this.running;
    this.measures.cutOff(Date.now() - waitStart, false, false);
    void this.turn(said, [`[From the bridge, not from Chris: ${this.stopped()} Answer what he says next.]`, shots].filter(Boolean).join("\n\n"));
  }

  /** The utterance held nothing a person said. Road noise must not cost a passage. */
  heardNothing(): void {
    this.measures.bargeInWas("nothing");
    this.apply("resume");
  }

  /**
   * One thing Chris said, and what it does to a held answer. `startedAt` is
   * when the utterance began, which only the ear knows.
   */
  async heard(said: string, startedAt?: number): Promise<void> {
    // 18.10 an utterance that repeats what the voice just said is the room, not
    // Chris: the phone's echo canceller let the speaker through. It is dropped
    // only when it began while the voice played or just after, because a
    // person may read a sentence back. A command is never dropped: the bridge
    // tells Chris which words to say, and he says them.
    const echoed = echoOf(said, this.mouth.lastSpoken);
    if (echoed) this.measures.echo(said, echoed);
    const awaited = this.awaitingCommand > Date.now();
    const reading = read(said, this.config, this.muted, awaited);
    const overVoice = startedAt !== undefined && (this.mouth.speaking || this.mouth.lastVoiceAt >= startedAt - ECHO_AFTER_MS);
    if (echoed && overVoice && reading.kind !== "command") {
      this.channel.journal(`the bridge dropped "${said}" as its own echo of "${echoed}"`);
      this.heardNothing();
      return;
    }
    if (echoed) this.channel.journal(`the bridge may have heard itself: "${said}" repeats "${echoed}"`);
    this.awaitingCommand = 0;
    this.channel.tell({ kind: "heard", text: said });
    this.measures.bargeInWas(reading.kind === "command" ? "command" : "speech");

    // 10.5 the gate fails closed: anything that is not the agreement word
    // cancels the action, and is then handled as what it was.
    if (this.gate && !reading.agreed) this.refuseGate(`Chris said "${said}"`);
    const { hold, then } = this.decide(said, reading);
    this.apply(hold);
    await then?.();
  }

  /** Which row of the table an utterance is. Everything it does to the hold is the `Hold` it returns. */
  private decide(said: string, reading: Reading): Outcome {
    if (reading.kind === "command") {
      this.measures.matched(said, reading.name);
      return { hold: this.run(reading.name) };
    }
    // 9.7 the wake word came through and the command did not. Wait for it
    // rather than complaining: the pause between the two is usually the reason.
    if (reading.kind === "unclear") {
      this.measures.matched(said, "waiting for the command");
      // Holding for the command and saying nothing is right. Saying nothing
      // anywhere is not: on 18 September the agent told Chris four times to put
      // the wake word in front of a sentence, and neither end could see why.
      this.channel.narrate(`the wake word arrived with no command, so nothing was done with: "${said}"`);
      this.awaitingCommand = Date.now() + this.config.wakeHoldMs;
      return { hold: "resume" };
    }
    if (this.muted) return { hold: "resume" };
    // 10.2 the agreement word is a word said plainly, not a wake command
    if (reading.agreed) {
      if (this.gate) { const act = this.gate.act; this.closeGate(); return { hold: act() }; }
      if (this.checkpointOpen) {
        this.checkpointOpen = false;
        this.agent.agree();
        this.reply("Carrying on.");
        return { hold: "resume" };
      }
    }
    // 15.1 a question that arrives mid-turn must not vanish into silence
    if (this.turnRunning) {
      if (!this.interrupting) {
        this.reply(`I am still on the last one. Say ${this.config.wakeWord}, end the turn, to stop it.`);
        return { hold: "resume" };
      }
      // 11.6 and 11.9 the Claude app's feel: the voice stops and the question
      // goes to the agent, with no phrase to say first. Item 4 it goes into the
      // turn that runs.
      this.measures.matched(said, "speech");
      // 14.12.6 taken now: a screenshot that arrives after it is for the turn after
      const shots = this.attached();
      return { hold: "discard", then: () => this.inject(said, shots) };
    }
    this.measures.matched(said, "speech");
    const shots = this.attached();
    return { hold: "discard", then: async () => { void this.turn(said, shots); } };
  }

  /**
   * 14.12.6 the line that names the pending screenshots to the agent, or
   * nothing. The agent opens a file when Chris's words need it.
   */
  private attached(): string {
    const files = this.screenshots?.() ?? [];
    for (const file of files) this.channel.journal(`the turn carries the screenshot ${file}`);
    if (files.length === 0) return "";
    if (files.length === 1) return `[From the bridge, not from Chris: he took a screenshot of the app on the phone before he said this. It is at ${files[0]}. Open it if his words need it.]`;
    return `[From the bridge, not from Chris: he took ${files.length} screenshots of the app on the phone before he said this. In the order he took them, they are at ${files.join(", ")}. Open them if his words need them.]`;
  }

  /** The one place an utterance reaches the held answer (11.3). */
  private apply(hold: Hold): void {
    if (hold === "resume") this.mouth.resume();
    if (hold !== "discard") return;
    const unspoken = this.mouth.discard().join(" ");
    // 11.10 the bubbles already hold these words, so they are recorded and not shown again
    if (unspoken) this.channel.journal(`not spoken: ${unspoken}`);
  }

  /**
   * 10.1 an action that waits. 10.4 reads back what it is about to do, 10.5
   * fails closed when no clear agreement comes, and the held answer waits with
   * it rather than resuming under the question.
   */
  private askFirst(what: string, denied: string, act: () => Hold, refused?: (why: string) => void, request?: string): void {
    this.reply(`${what} Say ${this.config.agreementWord} to let it happen.`);
    const seconds = Math.round(this.config.checkpointWindowMs / 1000);
    this.gate = {
      act,
      denied,
      refused,
      request,
      timer: setTimeout(() => { this.refuseGate(`no answer in ${seconds} seconds`); this.apply("resume"); }, this.config.checkpointWindowMs),
    };
  }

  private closeGate(): void {
    if (!this.gate) return;
    clearTimeout(this.gate.timer);
    this.gate = null;
  }

  /** 10.5 the gate closes without the action, and says so. */
  private refuseGate(why: string): void {
    const gate = this.gate;
    if (!gate) return;
    this.closeGate();
    gate.refused?.(why);
    this.reply(gate.denied);
  }

  /**
   * 10.7 the agent asks before a tool runs. The four actions of 10.7 wait for
   * the agreement word; anything else is let through at once, because the
   * agent is permissive (6.3). One gate at a time: a request that arrives
   * while a question is open is denied, and the agent is told why.
   */
  private permission(request: Permission): void {
    const what = gatedAction(request.tool, request.input, this.dir);
    const action = `${request.tool} ${JSON.stringify(typeof request.input.command === "string" ? request.input.command : request.input)}`;
    const answer = (allow: boolean, why: string, message?: string) => {
      this.agent.answer(request.id, allow, message);
      this.channel.journal(`the bridge ${allow ? "allowed" : "denied"} the agent's ${action}: ${why}`);
    };
    if (!what) { answer(true, "not a gated action"); return; }
    if (this.gate) {
      answer(false, "a question was already open", "The bridge denied this without asking Chris: a question to him is already open. Ask again after he answers it.");
      return;
    }
    this.askFirst(what, "Nothing was done.", () => {
      answer(true, `Chris said "${this.config.agreementWord}"`);
      return "resume";
    }, (why) => {
      answer(false, why, `Chris did not agree (${why}), so the bridge denied this. Do not run it, or another form of it, unless he asks for it again.`);
    }, request.id);
  }

  /** Not awaited by the caller: the microphone has to stay open through a turn. */
  async turn(said: string, note = ""): Promise<void> {
    const done = this.runTurn(said, note);
    this.running = done;
    await done;
  }

  /**
   * One turn. `note` is for the agent alone and never joins the transcript:
   * 11.10 uses it to say where an interrupt left Chris, and 14.12.6 to name
   * the pending screenshots.
   *
   * A turn whose result was back when Chris spoke still has its voice to
   * finish, and by then a newer turn owns the mouth. `mine` is what keeps the
   * older one from giving the cue into the middle of the new answer, or from
   * clearing the flags the new one just set. Item 4 speech written into the
   * turn does not make a new turn: the turn stays the mouth's, and its reply
   * is a new answer inside it.
   */
  private async runTurn(said: string, note: string): Promise<void> {
    let id = ++this.turnId;
    const mine = () => id === this.turnId;
    this.turnRunning = true;
    this.mouth.newTurn();
    const open = (n: number) => new Answer(n, this.channel, this.config.sentenceMaxChars, (sentence) => this.mouth.say(sentence, n), () => n === this.turnId, () => this.measures.firstDelta());
    let answer = open(id);
    this.answering = answer;
    // Item 4 the agent began a message after Chris spoke into the turn. It
    // answers him, so it is an answer of its own, and what he heard of the
    // one he spoke over is remembered as its own pair.
    this.injectedReply = () => {
      if (!mine()) return;
      answer.end();
      if (this.mouth.said.length > 0) this.remember(said, this.mouth.said.join(" "));
      if (this.injected.length > 0) said = this.injected.join(" ");
      this.injected = [];
      this.mouth.newTurn();
      id = ++this.turnId;
      answer = open(id);
      this.answering = answer;
    };
    const stopCue = this.cueWhileWaiting();
    const stopMusic = this.musicWhileWaiting(mine, () => answer.long);
    try {
      const result = await this.agent.ask([VERBOSITY_LINES[this.verbosity], note, said].filter(Boolean).join("\n\n"));
      if (!mine()) return;
      const turn = { ...result, text: withoutMarker(result.text) };
      answer.end();
      await this.mouth.drained();
      // 15.15 the true end of the speech: the result is back, so no sentence
      // is still to come; the answer has flushed its last one; and the mouth
      // has said what it had, or a discard took the rest. Between two
      // sentences the mouth also empties, but the result is not back, so this
      // line is not reached. The thinking cue is stopped first, so the two
      // figures cannot land together. A turn that said nothing gets no cue,
      // and a question that cut this turn owns the mouth now (11.9): a cue
      // then would answer the question, not end this turn.
      stopCue();
      if (answer.spoke && mine()) this.cue("done");
      this.lastReply = this.mouth.said.join(" ") || turn.text;
      this.remember(said, this.lastReply);
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
        this.injectedReply = null;
        this.injected = [];
        this.turnRunning = false;
        this.checkpointOpen = false;
      }
    }
  }

  /** 9.4.7 a request and the reply Chris heard, for "where are we"; the last three are kept. */
  private remember(said: string, reply: string): void {
    this.recent.push({ said, reply });
    if (this.recent.length > 3) this.recent.shift();
  }

  /**
   * 15.1 a wait must not be silence. 15.5 only once the wait is long enough.
   * 11.6.5 an opener is sound, so the wait counts again from its end.
   */
  private cueWhileWaiting(): () => void {
    let timer = setTimeout(function tick(this: Conversation) {
      const quiet = this.mouth.openerEndedAt + this.config.audioCueDelayMs - Date.now();
      if (quiet > 0) { timer = setTimeout(tick.bind(this), quiet); return; }
      // 15.1 a cue fills silence. Never over the voice — one transport shares a
      // single audio source and refuses two writers — and never while an answer
      // is wanted, because at the checkpoint the bridge has just asked for one.
      // 15.1 never while an answer is wanted: at the checkpoint the bridge has
      // just asked for one. cue() keeps it off the voice.
      if (!this.checkpointOpen && !this.gate) this.cue("thinking");
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
  private run(name: CommandName): Hold {
    switch (name) {
      // A setting changed and the answer did not, so the answer carries on.
      case "mute": this.muted = true; this.reply("Muted."); return "resume";
      case "unmute": this.muted = false; this.reply("Listening."); return "resume";
      // 15.4 the cues earn their keep while this is being built and are noise
      // once it works, so which it is stays Chris's to say, out loud.
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

      // 9.4.7 this is for reorienting when something feels wrong. If Chris is
      // reorienting, the passage he stopped is not what he wants back.
      case "where":
        if (this.recent.length === 0) { this.reply("We have not started yet."); return "resume"; }
        for (const pair of this.recent) this.reply(`You asked: ${pair.said} I said: ${firstSentence(pair.reply)}`);
        return "discard";

      // 11.10 the rest of an answer a barge-in took off the queue. The agent is
      // not asked again: these are its own words, already paid for.
      case "carryOn":
        if (!this.mouth.carryOn()) { this.reply("There is nothing left of it."); return "resume"; }
        // 15.15 the rest is the end of a turn's speech, put off by a barge-in,
        // so it ends with the cue. Said inside a turn it joins that turn's
        // speech, and the turn's own end has the cue. A question that cuts
        // the replay takes the turn number with it, and the cue with that.
        if (!this.turnRunning) {
          const id = this.turnId;
          void this.mouth.drained().then(() => { if (id === this.turnId) this.cue("done"); });
        }
        return "resume";

      case "interruptOn": return this.setInterrupting(true);
      case "interruptOff": return this.setInterrupting(false);

      // item 37 the level is for the next turn, so the answer carries on
      case "verbosityBrief": return this.setVerbosity("brief");
      case "verbosityNormal": return this.setVerbosity("normal");
      case "verbosityFull": return this.setVerbosity("full");
      // one level either way; at either end it stays where it is
      case "shorter": return this.setVerbosity(VERBOSITIES[Math.max(VERBOSITIES.indexOf(this.verbosity) - 1, 0)] as Verbosity);
      case "longer": return this.setVerbosity(VERBOSITIES[Math.min(VERBOSITIES.indexOf(this.verbosity) + 1, VERBOSITIES.length - 1)] as Verbosity);

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

      // 8.8 a fresh process is a fresh context. 10.1 gates it, because what it
      // costs is the whole conversation.
      case "clearContext":
        this.askFirst("I am about to clear the context and start again.", "Nothing was cleared.", () => {
          this.agent.restart("cleared by voice");
          this.reply("Context cleared.");
          return "discard";
        });
        return "keep";
    }
  }

  /**
   * 11.11 a turn nobody asked for, spoken.
   *
   * A background job that finishes hands Claude Code a task notification, and
   * it answers: measured 18 September, four such turns across three runs, every
   * word of them dropped. Its first word opens an answer, which streams to the
   * client as a turn Chris asked for does. Its sentences go through `reply`,
   * which jumps a hold, because what they carry is news and the answer they
   * land on is not.
   */
  private streaming(): Answer {
    if (this.answering) return this.answering;
    const id = ++this.turnId;
    this.answering = new Answer(id, this.channel, this.config.sentenceMaxChars, (sentence) => this.mouth.reply(sentence, id), () => id === this.turnId);
    return this.answering;
  }

  /** 11.11 the result of the answer the agent began unasked. One with no words opened none, and says nothing. */
  private async unprompted(turn: Turn): Promise<void> {
    const answer = this.answering;
    if (!answer) return;
    this.answering = null;
    answer.end();
    this.channel.tell({ kind: "turn", number: turn.number, text: withoutMarker(turn.text.trim()), costUsd: this.agent.totalCostUsd(), answer: answer.id });
    // 15.15 a report is news, and it ends as a turn does: after its last
    // sentence has played, unless a question took the mouth first.
    await this.mouth.drained();
    if (answer.spoke && answer.id === this.turnId) this.cue("done");
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
      // first and the audio goes off the moment it ends (11.12.2)
      this.mouth.quietAfter("Audio off.");
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

  /** Item 37 kept across restarts, and said back so Chris hears where it landed. */
  private setVerbosity(level: Verbosity): Hold {
    this.verbosity = level;
    this.onSetting?.({ verbosity: level });
    this.reply(`Verbosity ${level}.`);
    return "resume";
  }

  /**
   * Item 28 the hold music volume, from the app's slider. It has no spoken
   * command and no answer: the slider shows where it landed.
   */
  private setMusicGain(gain: number): void {
    this.mouth.setMusicGain(gain);
    this.onSetting?.({ holdMusicGain: gain });
  }

  /**
   * Item 44 a threshold of the ear, from the app's options screen. Like the
   * volume it has no spoken command and no answer. It is checked by the rule
   * the file is checked by: a value the bridge took live is written to the
   * file, and a start that refused it would look like the bridge is broken. A
   * refused value is not kept, and every client is sent the settings in force
   * again, so a control that moved under the finger goes back.
   */
  private setThreshold(key: Threshold, value: number): void {
    try {
      checkConfig({ ...this.config, [key]: value });
    } catch (error) {
      this.channel.journal(`refused ${key} ${value}: ${(error as Error).message}`);
      this.channel.settings();
      return;
    }
    this.onSetting?.({ [key]: value });
  }

  /**
   * 9.4.9 a setting a client changed. It goes through the same paths a spoken
   * command does, the voice's answer included, so tapping a switch and saying
   * the words cannot end anywhere different. A key it does not know is ignored:
   * a client may not reach the settings the car has no command for. The hold
   * music volume (item 28), from 0 to 1, and the three thresholds of the ear
   * (item 44) are the exceptions: each has a control and no command.
   */
  set(patch: Record<string, unknown>): void {
    if (typeof patch.tones === "boolean") this.setTones(patch.tones);
    if (typeof patch.holdMusic === "boolean") this.setHoldMusic(patch.holdMusic);
    if (typeof patch.interruptOnSpeech === "boolean") this.setInterrupting(patch.interruptOnSpeech);
    if (patch.voice === "female" || patch.voice === "male") this.switchVoice(patch.voice);
    if (VERBOSITIES.includes(patch.verbosity as Verbosity)) this.setVerbosity(patch.verbosity as Verbosity);
    if (typeof patch.holdMusicGain === "number" && patch.holdMusicGain >= 0 && patch.holdMusicGain <= 1) this.setMusicGain(patch.holdMusicGain);
    for (const key of THRESHOLDS) {
      if (typeof patch[key] === "number") this.setThreshold(key, patch[key]);
    }
  }

  /** One utterance of PCM becomes one thing Chris said. */
  start(): void { this.agent.start(); }
  stop(): void { this.agent.stop(); }
}

/** Item 44 the settings of the ear that the options screen changes, and no command does. */
const THRESHOLDS = ["bargeInLevel", "minSpeechPeak", "endOfTurnPauseMs"] as const;
type Threshold = typeof THRESHOLDS[number];

/**
 * Item 37 the one line at the head of every turn's prompt. It names the level
 * and says what it means, because the agent reads it and nothing else does.
 */
const VERBOSITY_LINES: Record<Verbosity, string> = {
  brief: "[From the bridge, not from Chris: verbosity is brief. Answer in one or two sentences, and give only the result.]",
  normal: "[From the bridge, not from Chris: verbosity is normal. Answer as you usually do.]",
  full: "[From the bridge, not from Chris: verbosity is full. Give your reasoning and more detail.]",
};

function firstSentence(text: string): string {
  const at = text.search(/[.!?]\s/);
  return at < 0 ? text : text.slice(0, at + 1);
}
