import { describe, expect, test } from "bun:test";
import { echoOf } from "../src/echo.ts";

/**
 * 18.10 the check that would have caught the volume slider of 21 September on
 * its first real run, instead of on a drive.
 */
describe("hearing itself (18.10)", () => {
  const spoken = ["I will look at the logs now.", "The service restarted about nine minutes ago."];

  test("the microphone hearing the speaker is an echo", () => {
    // what whisper writes from the room is the sentence, give or take the punctuation
    expect(echoOf("the service restarted about nine minutes ago", spoken))
      .toBe("The service restarted about nine minutes ago.");
  });

  test("a few words wrong is still an echo, because a room is not a wire", () => {
    expect(echoOf("the service restarted about nine minutes uh go", spoken))
      .toBe("The service restarted about nine minutes ago.");
  });

  test("what Chris actually says is not", () => {
    expect(echoOf("what did the logs say about the restart", spoken)).toBeNull();
    expect(echoOf("read me the last part again", spoken)).toBeNull();
  });

  test("a short utterance is never an echo, because the bridge says those words too", () => {
    // "stop", "carry on", "say again" are Chris's commands and the bridge's own replies
    expect(echoOf("carry on", ["Carry on.", "Stopped."])).toBeNull();
    expect(echoOf("stop", ["Stopped."])).toBeNull();
  });

  test("nothing said yet is nothing to echo", () => {
    expect(echoOf("the service restarted about nine minutes ago", [])).toBeNull();
  });

  test("the newest sentence wins when two could match", () => {
    expect(echoOf("i will look at the logs now", ["I will look at the logs now.", "I will look at the logs now, again."]))
      .toBe("I will look at the logs now, again.");
  });
});
