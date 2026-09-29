/**
 * A fake clock for the tests that wait on time: the hold music, the cues, the
 * announcements, the backoff. They used to wait on the real clock, and 64 of
 * them took 30 of the suite's 33 seconds.
 *
 * `pass` moves the clock a few milliseconds at a time and lets what each step
 * woke run before the next, so a chain of timers and promises runs in the
 * order it runs on the real clock. `setImmediate` stays real under bun's fake
 * timers, so it is what lets the promises settle.
 */
import { afterEach, beforeEach, jest } from "bun:test";

/** Each test of the calling `describe`, or of the file at the top level, runs on the fake clock. */
export function fakeClock(): void {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });
}

/** Lets the promises and the I/O that are ready run. */
export const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** Moves the clock on by `ms`, `step` at a time. */
export async function pass(ms: number, step = 2): Promise<void> {
  await settle();
  for (let gone = 0; gone < ms; gone += step) {
    jest.advanceTimersByTime(Math.min(step, ms - gone));
    await settle();
  }
}

/**
 * Moves the clock on until `done`, and gives up after `ms` of it. On the real
 * clock it waits, for the few tests that freeze the time with `setSystemTime`.
 */
export async function until(done: () => boolean, ms = 2_000, step = 2): Promise<void> {
  if (!jest.isFakeTimers()) {
    for (let gone = 0; gone < ms && !done(); gone += 10) await new Promise((resolve) => setTimeout(resolve, 10));
    return;
  }
  await settle();
  for (let gone = 0; gone < ms && !done(); gone += step) {
    jest.advanceTimersByTime(step);
    await settle();
  }
}

/** Moves the clock on until `promise` settles, and gives what it gives. */
export async function finish<T>(promise: Promise<T>, ms = 5_000): Promise<T> {
  let done = false;
  promise.then(() => { done = true; }, () => { done = true; });
  await until(() => done, ms);
  return promise;
}
