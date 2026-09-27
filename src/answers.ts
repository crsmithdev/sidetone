/**
 * Which answer owns the mouth (spec 11.9, 11.11, 15.15).
 *
 * An answer is a turn Chris asked for, the reply to words he said into one
 * (item 4), or one the agent began unasked (11.11). Each answer this opens
 * takes the mouth from the one before. A question that arrives once a turn's
 * result is back takes it too, before its own turn opens (11.9). An older
 * answer goes on until its voice is done, and by then it must not speak, give
 * the done cue, or clear what the newer one set.
 *
 * Ownership is one number: the id of the answer that owns the mouth. It is
 * compared in one place, `owner`. The class is not called `Turn`, because
 * `session.ts` has that name for the agent's result, and one turn can hold
 * more than one answer.
 */
import type { Answer } from "./answer.ts";

/**
 * How an answer is made. `asked` decides how its sentences reach the mouth:
 * behind a hold, or ahead of it (11.11). `live` is false once a newer answer
 * owns the mouth.
 */
export type OpenAnswer = (id: number, asked: boolean, live: () => boolean) => Answer;

export class Answers {
  /** the id of the answer that owns the mouth */
  private latest = 0;
  private words: Answer | null = null;
  private running = false;

  constructor(
    private readonly open: OpenAnswer,
    /** resolves once the mouth has said what it had, or a discard took it */
    private readonly drained: () => Promise<void>,
    /** 15.15 the done cue */
    private readonly done: () => void,
  ) {}

  /** Where the agent's words and blocks go: the latest answer, or null between answers. */
  get current(): Answer | null { return this.words; }

  /** Whether a turn Chris asked for runs. */
  get busy(): boolean { return this.running; }

  /** An answer Chris asked for: a new turn, or the reply to words he said into the turn that runs (item 4). */
  ask(): Answer {
    this.running = true;
    return this.words = this.next(true);
  }

  /** 11.11 the answer the agent's words go to when nobody asked: the current one, or a new one. */
  unasked(): Answer {
    return this.words ??= this.next(false);
  }

  /** 11.9 the turn's result is back and Chris asked again: the mouth is no longer the turn's, and no answer owns it yet. */
  take(): void {
    this.latest++;
  }

  owns(answer: Answer): boolean {
    return this.owner(answer.id);
  }

  /**
   * The turn of `answer` is over. Only the turn whose answer still owns the
   * mouth stops the words and says no turn runs; an older one would clear
   * what the newer one set. True when it owned the mouth.
   */
  close(answer: Answer): boolean {
    if (!this.owns(answer)) return false;
    this.words = null;
    this.running = false;
    return true;
  }

  /** 11.11 the result of the unasked answer is back: the words stop going to it. Null when it had no words. */
  release(): Answer | null {
    const answer = this.words;
    this.words = null;
    return answer;
  }

  /**
   * 15.15 the stream of `answer` is over: what it holds goes out, and once the
   * mouth has said it, the done cue. An answer that said nothing gets none. A
   * newer answer that took the mouth meanwhile gets none either: a cue then
   * would answer the question, not end this one (11.9). With no answer it is
   * the rest a barge-in kept (11.10), and whatever owns the mouth now keeps
   * it or gets no cue.
   */
  async end(answer?: Answer): Promise<void> {
    answer?.end();
    const id = answer ? answer.id : this.latest;
    await this.drained();
    if ((answer?.spoke ?? true) && this.owner(id)) this.done();
  }

  /** The one rule: an id is current while no newer answer took the mouth. */
  private owner(id: number): boolean {
    return id === this.latest;
  }

  private next(asked: boolean): Answer {
    const id = ++this.latest;
    return this.open(id, asked, () => this.owner(id));
  }
}
