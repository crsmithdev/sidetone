# The delivery layer: an architecture review

23 September 2026, at `f2d7b5c`. To-do item 23.

This review covers how the bridge and the app get bytes to each other over
the control channel (4.3). It covers chunking, compression, framing and
reliability. It does not cover the audio. The service review and the app
review of 22 September cover the two ends.

An earlier pass at this layer is in the build plan of 22 September, as the
"wire" items. This document is the written review that item 23 asks for. It
says which of those items landed, and it adds what the earlier pass missed.

## What is fixed

The review treats these as fixed, and so do its recommendations:

- One LiveKit room carries everything. ADR 0002.
- A message on the control channel is one UTF-8 JSON object with a `kind`.
  Both directions. The page, the app and the fake phone all read it that way.
- `publishData` with `reliable: true`: ordered, retransmitted by SCTP, and
  lost only when the connection under it goes.

## The layer as it is

| Path | Sender | Split | Size of a part | Receiver | On a failed publish |
|---|---|---|---|---|---|
| Bridge → client, every kind | `src/outbound.ts` | none | whole message, measured against `MAX_MESSAGE_BYTES` = 60,000 | `decode` in the app and the page | journal line; the message is lost; a `history` over the limit is first trimmed to its newest turns |
| App → bridge, small kinds (`mic`, `voice`, `said`, `setting`, `quality`) | `Bridge.tell` | none | a few hundred bytes | `src/channel.ts` | `Log.w`; the message is lost |
| App → bridge, screen log | `Bridge.sendScreenLog` | `screenParts` groups whole entries | under `SCREEN_PART_BYTES` = 12,000 | `src/screen.ts` appends each part alone | the failed part and all after it go back to `unsent`; the next tick, one second later, sends them again |
| App → bridge, screenshot | `Bridge.sendScreenshot` | `screenshotParts` slices the base64 | under `SCREENSHOT_PART_BYTES` = 12,000 | `src/screenshot.ts` keeps parts until it has `of` of them | `Log.w`; the rest of the image is not sent, and nothing sends it again |

### The limit

The handoff of 23 September records the measurement. A payload of 62,996
bytes arrives. A payload of 63,996 bytes is refused with
`data packet size (64035 bytes) exceeds the negotiated maximum`, and
`publishData` rejects. Nothing is truncated.

The probe sent from `@livekit/rtc-node` to `@livekit/rtc-node`. Nobody has
measured a publish from the Android SDK. The limit is the SFU's negotiated
SCTP maximum, so the app probably sees the same figure, but that is a
reading, not a measurement.

### Compression

Nothing is compressed, in either direction.

| Payload | What compression would give |
|---|---|
| The screenshot | Nothing. It is already a JPEG (`SCREENSHOT_QUALITY` = 70, `SCREENSHOT_EDGE` = 1,080). The cost is the base64: 4 bytes for each 3, so a third more parts. |
| The screen log | Much, as a ratio: JSON with repeated keys. Little, as bytes: the largest log on disk is 167,580 bytes over about 20 minutes, which is about 140 bytes a second. |
| Bridge → client | `delta`, `sentence` and `turn` are small. `history` is the one large message, and the trim already bounds it. |

### Framing

Every message is self-describing JSON. There is no envelope, no sequence
number and no version. The two split payloads carry `id`, `part` and `of`:

- The screen log's parts are **batches**, not fragments. Each holds whole
  entries and is complete alone. `src/screen.ts` reads `id` and `entries`
  and never reads `part` or `of`.
- The screenshot's parts are **fragments**. One alone is useless. The bridge
  needs every one of them, and uses `of` to know when it has them.

This is the difference that matters in the rest of the review.

## Intentional or accident

| Choice | Verdict | Evidence |
|---|---|---|
| JSON with `kind` for every message | Intentional | ADR 0007 and the one fixture of `104485a`; the glossary names one vocabulary for the control channel |
| Bridge side: one exit that encodes, measures, orders and catches | Intentional | `src/outbound.ts` header; commit `23fe759` |
| `MAX_MESSAGE_BYTES` = 60,000 | Intentional, measured | comment in `src/outbound.ts` |
| Parts of 12,000 bytes on the app | Accident, harmless | Chosen when the code believed 12 to 15 KiB. The measurement came after. `ScreenLog.kt` now cites the 64 KB figure and keeps 12,000 as margin; `Screenshot.kt` still says "about 15 KiB". |
| The screen log retries | Intentional | Spec 14.11.1: "A message that fails goes again at the next second." |
| The screenshot does not retry | Specified, not reasoned | Spec 14.12.3: "The app does not send a part again." No ADR, no comment and no commit message says why. `d4ab263` says only that the image goes "over the same data channel as the screen log". |
| Batches for the log, fragments for the image | Intentional, and correct | The payloads differ in kind: an entry is useful alone, a slice of a JPEG is not. |
| `part` and `of` on a screen message | Accident | Copied framing; the bridge ignores them. |
| Base64 inside JSON for the image | Accident of the framing | JSON cannot carry bytes, so the image became text. Nobody weighed a binary path. |
| No compression | Default, not a decision | Nothing records a choice. It costs little except for the base64 above. |
| No split from bridge to client | Partly intentional | `history` is trimmed on purpose. Any other message over 60,000 bytes is lost with a journal line. Only a `turn` of about 10,000 words can reach that. |
| Three send paths on the app | Accident | `tell`, `sendScreenLog` and `sendScreenshot` each call `publishData` their own way. The bridge had the same fault and fixed it with `Outbound`. |

### Why the two differ

The screen log retries because it streams. It sends once a second for the
whole life of a room, a room drop is routine in the car, and `unsent`
outlives the room. The retry comes free from that shape.

The screenshot is one shot. It lives in one coroutine and holds the JPEG in
a local. When that coroutine returns, the image is gone. Nobody chose
"drop the image". The code has no place to keep it.

The spec then wrote down what the code did. So the difference is where each
feature landed, and the spec line records the accident. It is not a
decision.

## Findings

### 1. A lost screenshot is silent, and the agent reads the old one

When one part fails, the app writes `Log.w` and stops. Chris sees nothing.
The bridge holds the incomplete image in `pending` and says nothing until a
*different* image arrives (`src/screenshot.ts:41`). Meanwhile
`latest.jpg` still points at the image before. The agent, told "look at the
screenshot", reads `latest.jpg` and describes a screen Chris did not mean.

A wrong answer is worse than no answer. The same fault holds when the bridge
restarts between two parts, because `pending` lives in memory.

### 2. The screenshot path has never run on the phone

`~/.sidetone/screenshots/` does not exist on this machine. The journal reaches
back to 21 September and has no `screenshot at` line. The unit tests cover
`screenshotParts` and `Screenshots.receive` separately. Nothing has carried
one image from the phone to the disk.

### 3. The screenshot sends about six times the parts it needs

Each part holds 11,872 base64 characters, which is 8,904 bytes of JPEG. An
image of 100 KB, which is an estimate for a 486 × 1,080 screen of text at
quality 70, is 12 parts. As binary in parts of 60,000 bytes it is 2. Each
part that a dropped room can cut is one more way to reach finding 1.

Both SDKs in use ship LiveKit byte streams: `livekit-android` 2.28.2 has
`io.livekit.android.room.datastream`, and `@livekit/rtc-node` 0.13.35 has
`registerByteStreamHandler`. A byte stream splits, reassembles and carries
binary. It would remove `screenshotParts`, the base64, `MAX_PARTS` and the
reassembly in `src/screenshot.ts`. It does not by itself resend after a
dropped room, so it does not replace finding 1's fix.

### 4. The app has no single exit

`tell` launches one coroutine for each message and does not wait. The bridge
had this shape and it let a `delta` and its `sentence` cross (14.9). On the
app the kinds are few and small, and the SDK probably queues them in order.
Nobody has checked that. The practical risk is a `mic` off and a `mic` on
that arrive the wrong way round. That fault is rare and would show as a
microphone in the wrong state.

### 5. The phone-to-bridge direction has no shared fixture

`test/fixtures/messages.jsonl` holds only what the bridge sends. The `screen`
and `screenshot` messages are written in `Messages.kt` and read in
`src/screen.ts` and `src/screenshot.ts`, and the two agree by eye. A renamed
field fails in no test.

### 6. The screen log's size promise holds for ASCII only

`ScreenLog.add` bounds `text` and `got` at 4,000 characters each. A part
promises under 12,000 bytes. 8,000 characters of CJK, at 3 bytes each, is
24,000 bytes in one entry. `screenParts` then makes one part of that entry
alone, over 12,000 bytes. The 60,000 byte limit still holds, so nothing
fails. The test `anEntryOfAnyLengthStillFitsOnePart` uses digits and cannot
see it. The comment on `Shown` still describes a stall that the bound now
prevents.

### 7. Smaller points

- `sendScreenLog` parses each part it made to count its entries
  (`Bridge.kt:458`), because `screenParts` returns bytes and not groups.
- `Screenshot.kt:25` says the channel carries "about 15 KiB". To-do item 23
  says 12 to 15 KiB. The measured figure is 64 KB.
- The page's `publishData` call (`client/index.html:273`) is not awaited or
  caught. A browser only logs an unhandled rejection, so this is cosmetic.

## What landed from the earlier pass

| Earlier item | State |
|---|---|
| wire 1: catch the failed publish, cap the history | Landed, `23fe759` (`src/outbound.ts`) |
| wire 2: bound `got` in the screen log | Landed, `23fe759`; finding 6 is what is left |
| measure the limit | Done: 62,996 arrive, 63,996 refused |
| wire 3 and 4: delete the advertised vocabulary; one fixture | Landed, `104485a`; bridge to client only, see finding 5 |
| wire 5: one module for a payload sent in parts | Open. See the ranking: do not build it. |
| wire 6: coalesce the deltas | Open, and still unmeasured |
| dead fields `part` and `of` on `screen` | Open, finding 7 level |

## What to act on, in order

| Rank | Action | Why this rank | Size |
|---|---|---|---|
| 1 | Take one screenshot on the phone with the newest APK, then read the journal and `latest.jpg` | Finding 2. Everything below assumes the path works. | one screenshot |
| 2 | Give the screenshot the screen log's shape: keep the JPEG until the bridge has all of it, and send the whole image again on the next room. Tell Chris when it is given up. On the bridge, remove `latest.jpg` when a new `id` starts, or journal the incomplete image after a timeout. | Finding 1. The only fault here that makes the agent say something wrong. The bridge already accepts a part twice, so a resend of the whole image needs no bridge change for the retry. | app: one module and a test; bridge: a few lines |
| 3 | Change spec 14.12.3 to say what rank 2 builds | The spec now records the accident as a rule. | one paragraph |
| 4 | Move the screenshot to a LiveKit byte stream | Finding 3. It removes a splitter and a reassembler from both ends, and cuts the parts to about a sixth. Do it after rank 2, because the retry sits above the transport either way. | medium; needs a probe of byte streams from the Android SDK first |
| 5 | Add `screen` and `screenshot` to a fixture that `Messages.kt` writes and the bridge replays | Finding 5 | small |
| 6 | One exit on the app, the pattern of `Outbound` | Finding 4. Low risk today; do it when `Bridge.kt` gets its seam, which the handoff ranks next anyway. | small, inside that work |
| 7 | Tidy: fix the two stale comments, count bytes in the ASCII-only test, drop `part` and `of` from `screen` or document them | Findings 6 and 7 | minutes |

Do not act on these:

- **One module for every payload sent in parts** (earlier wire 5). The
  screen log sends batches and the screenshot sends fragments. One module
  would have to hide that difference. After rank 4 only the batches are
  left, so no second user exists.
- **Compression.** The one large payload is already a JPEG. The log is 140
  bytes a second.
- **A split for bridge-to-client messages.** Only a `turn` of about 10,000
  words can pass the limit, and the journal says so when one does.
- **A larger `SCREEN_PART_BYTES`.** 12,000 is under a fifth of the limit and
  costs nothing at 140 bytes a second. The Android limit is unmeasured.

## Not verified

- The Android SDK's own publish limit. The measurement ran on the Node SDK.
- The size of a real screenshot. The 100 KB figure is an estimate; rank 1
  gives the real one.
- The order of `tell` messages on the app (finding 4).
- Whether byte streams work between these two SDK versions against this
  LiveKit server. The classes exist in both; nothing has sent one.
