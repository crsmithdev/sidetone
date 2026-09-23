import { expect, test } from "bun:test";
import { DEFAULTS } from "../src/config.ts";
import { INCOMING, OUTGOING, REFUSED, endTurnPhrase, protocolMessage } from "../src/messages.ts";
import { match } from "../src/commands.ts";

test("the end-turn phrase is built from the wake word, and the bridge answers it", () => {
  expect(endTurnPhrase(DEFAULTS)).toBe("sidetone end the turn");
  const heard = match(endTurnPhrase(DEFAULTS), DEFAULTS.wakeWord, false, DEFAULTS.mutedCommands, DEFAULTS.wakeWordVariants);
  expect(heard).toEqual({ kind: "command", name: "endTurn" });
});

test("a different wake word moves the phrase with it", () => {
  const config = { ...DEFAULTS, wakeWord: "hey brain" };
  expect(endTurnPhrase(config)).toBe("hey brain end the turn");
  expect(match(endTurnPhrase(config), config.wakeWord, false, config.mutedCommands, [])).toEqual({ kind: "command", name: "endTurn" });
});

test("the message a client joins to carries the vocabulary", () => {
  const message = protocolMessage(DEFAULTS) as { kind: string; endTurn: string; incoming: Record<string, string> };
  expect(message.kind).toBe("protocol");
  expect(message.endTurn).toBe("sidetone end the turn");
  expect(Object.keys(message.incoming)).toEqual(["heard", "sentence", "blockStart", "delta", "blockEnd", "turn", "narration", "error", "history", "protocol", "rejoin", "working", "settings", "speaking"]);
  expect(OUTGOING).toEqual(["said", "mic", "quality", "voice", "screen", "screenshot", "setting"]);
});

test("what counts as a refused token", () => {
  const refused = new RegExp(REFUSED, "i");
  expect(refused.test("could not establish signal connection: invalid API key")).toBe(true);
  expect(refused.test("Expected HTTP 101 response but was '401 Unauthorized'")).toBe(true);
  expect(refused.test("Unable to resolve host \"lightbox2\"")).toBe(false);
});

/**
 * The refusal rule is the one fact a client needs before any message can
 * arrive, so each client states it. On 17 September 2026 the app learned
 * "invalid API key" and the page did not, and the page then reloaded into the
 * same failure every five seconds for half a day. These fail when they drift.
 */
test("both clients state the same refusal rule as the bridge", async () => {
  const page = await Bun.file(new URL("../client/index.html", import.meta.url).pathname).text();
  const app = await Bun.file(new URL("../android/app/src/main/java/dev/crsmith/sidetone/Pairing.kt", import.meta.url).pathname).text();
  expect(page).toContain(REFUSED);
  expect(app).toContain(REFUSED);
});

test("the join message offers the served app only when there is one (17.15)", () => {
  const apk = { url: "https://bridge:3100/sidetone.apk", sha256: "ab12" };
  expect(protocolMessage(DEFAULTS, apk)).toMatchObject({ kind: "protocol", apk });
  expect("apk" in protocolMessage(DEFAULTS)).toBe(false);
});
