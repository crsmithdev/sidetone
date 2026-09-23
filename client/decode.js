/**
 * 4.3 what the page does with one message from the bridge, as data: the page
 * acts on it, and a test replays `test/fixtures/messages.jsonl` through it,
 * which is what the bridge really sends. The fake phone reads messages with it
 * too. A kind this does not know is the two ends drifting apart, and it says
 * so rather than dropping it, which is how the drift stayed hidden before.
 *
 * What it gives back:
 *   { history: [[text, "you" | "bridge"], ...] }   14.8 the turns a client missed
 *   { endTurn }                                    the words the Stop button says
 *   { line: [text, "you" | "note"] }               a line of its own
 *   { sentence: [text, answer] }                   14.7 grows the answer's line
 *   { answered: [text, answer] }                   14.7 the whole answer takes its line's place
 *   {}                                             nothing to show
 */
export function decode(message) {
  switch (message.kind) {
    case "history":
      return {
        history: (message.turns ?? []).flatMap((past) =>
          past.kind === "heard" ? [[past.text, "you"]] : past.kind === "turn" ? [[past.text, "bridge"]] : []),
      };
    // 4.3 the bridge says what a client has to say back to it, so the Stop
    // button is never a phrase the wake word has moved away from
    case "protocol": return { endTurn: message.endTurn };
    case "heard": return { line: [message.text, "you"] };
    case "sentence": return { sentence: [message.text, message.answer] };
    case "turn": return { answered: [message.text, message.answer] };
    case "narration":
    case "error": return { line: [message.text, "note"] };
    // 9.4.9 the app can show the settings in force and change one. The page cannot.
    case "settings":
    // 14.13 the app lights the words the voice is saying. The page shows the
    // whole sentence as soon as it is known, so it has nothing to light.
    case "speaking":
    // 18.9 the app renews its own microphone track on this; the page does not
    case "rejoin":
    // 14.10 the app shows a sign that the agent works. The page shows nothing.
    case "working":
    // 17.15.5 a new build of the app. The page is not the app.
    case "apk":
    // 14.12.7 the app shows the mark on the thumbnail of its screenshot. The page sends none.
    case "screenshot":
    // 14.9 the app shows a bubble for each block of an answer. The page keeps its
    // one line for each answer, grown by sentences, so it ignores the blocks.
    case "blockStart":
    case "delta":
    case "blockEnd": return {};
    default: return { line: [`(unknown message: ${message.kind})`, "note"] };
  }
}
