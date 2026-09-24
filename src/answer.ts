/**
 * One answer on its way out: its words, its blocks and its sentences, each told
 * to the client under the answer's number (14.7, 14.9). A turn Chris asked for
 * and a turn nobody asked for (11.11) both stream through one, so a client
 * cannot tell the two apart until the voice treats them differently.
 */
import type { Channel } from "./channel.ts";
import { LongMarker, SentenceCollector } from "./sentences.ts";

export class Answer {
  private readonly sentences: SentenceCollector;
  // 15.7.4 the marker is taken off before the words go anywhere
  private readonly marker = new LongMarker();
  // 14.9 the blocks of this answer that hold text, counted here: the stream's index restarts with each message
  private block = 0;
  // 14.9.2 the deltas of the current block, counted so the app can put them in order
  private seq = 0;
  private open = false;
  private firstWord = true;
  /** item 4 Chris spoke over this answer: the rest of it goes to the client and not to the voice */
  private hushed = false;
  /** 15.15 whether any sentence reached the voice: an answer that said nothing gets no cue at its end. */
  spoke = false;

  constructor(
    readonly id: number,
    private readonly channel: Channel,
    sentenceMaxChars: number,
    /** how a sentence reaches the voice: the answer's queue, or ahead of a hold (11.11) */
    private readonly speak: (sentence: string, answer: number) => void,
    /** false once a newer answer owns the mouth: a new turn, or the reply to words written into this one */
    private readonly live: () => boolean,
    /** 18.4 the agent's share of the round trip ends with its first word */
    private readonly onFirstWord: () => void = () => {},
  ) {
    this.sentences = new SentenceCollector(sentenceMaxChars);
  }

  /** 15.7.4 and 15.7.5 whether the agent said the answer is long, or showed it with a tool call. */
  get long(): boolean { return this.marker.long; }

  delta(text: string): void {
    if (!this.live()) return;
    if (this.firstWord) { this.firstWord = false; this.onFirstWord(); }
    this.words(this.marker.push(text));
  }

  blockStart(type: string): void {
    if (!this.live()) return;
    // 15.7.5 a tool call is proof enough that the turn is long, marker or not
    if (type === "tool_use") { this.words(this.marker.end()); this.endSentence(); this.marker.long = true; }
    if (type !== "text") return;
    this.open = true;
    this.seq = 0;
    this.channel.tell({ kind: "blockStart", answer: this.id, block: ++this.block });
  }

  blockEnd(): void {
    if (!this.live() || !this.open) return;
    this.open = false;
    this.channel.tell({ kind: "blockEnd", answer: this.id, block: this.block });
    this.endSentence();
  }

  /** Item 4 Chris spoke into the turn: from now on this answer is shown and not said. */
  hush(): void {
    this.hushed = true;
  }

  /** The stream is over: what the marker and the collector still hold goes out. */
  end(): void {
    if (!this.live()) return;
    this.words(this.marker.end());
    this.endSentence();
  }

  private words(text: string): void {
    if (!text) return;
    // 14.9 the words reach the client before the sentence that finishes with them
    this.channel.tell({ kind: "delta", text, answer: this.id, block: this.block, seq: ++this.seq });
    for (const sentence of this.sentences.push(text)) this.say(sentence);
  }

  // item 31: a block is complete, so a full stop at its end cannot become a number or an ellipsis
  private endSentence(): void {
    const tail = this.sentences.flush();
    if (tail) this.say(tail);
  }

  // 14.7 a sentence reaches the client as soon as it is known, which is
  // before the voice reaches it: asked for on the drive of 18 September,
  // when the words arrived only after the whole answer had been spoken.
  private say(sentence: string): void {
    this.channel.tell({ kind: "sentence", text: sentence, answer: this.id });
    if (this.hushed) return;
    this.spoke = true;
    this.speak(sentence, this.id);
  }
}
