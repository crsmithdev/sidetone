#!/usr/bin/env bun
/**
 * Whether a screenshot holds back the words of an answer on a slow link, sent
 * as parts on the control channel or as one HTTP POST (docs/todo.md, item 59).
 *
 * Two LiveKit participants in a private room. `bridge` runs on the host and
 * streams a small delta every 50 ms, stamped with the time it went. `phone`
 * runs in a network namespace whose link has netem on it, joins, and 3 s in
 * sends one screenshot: 12,000-byte parts of base64 on the reliable data
 * channel, as the app does (`parts`), or one POST of the JPEG
 * (`http`). It prints the delay of each delta after the send starts.
 *
 * It needs sudo, Docker and a private LiveKit server; it does not touch the
 * bridge's own. The setup, with `livekit.yaml` on port 7990, rtc tcp 7991, udp
 * 7992, node_ip 10.59.0.1, bind_addresses 127.0.0.1 and 10.59.0.1, and a key
 * that both roles read from LIVEKIT_API_KEY and LIVEKIT_API_SECRET:
 *
 *   sudo ip netns add st59; sudo ip link add st59h type veth peer name st59n
 *   sudo ip link set st59n netns st59; sudo ip addr add 10.59.0.1/24 dev st59h; sudo ip link set st59h up
 *   sudo ip netns exec st59 sh -c 'ip addr add 10.59.0.2/24 dev st59n; ip link set st59n up; ip link set lo up; ip route add default via 10.59.0.1'
 *   docker run -d --rm --name st59-livekit --network host -v $PWD/livekit.yaml:/livekit.yaml livekit/livekit-server --config /livekit.yaml
 *   sudo ip netns exec st59 tc qdisc replace dev st59n root netem rate 64kbit delay 150ms loss 1%   # the uplink
 *   sudo tc qdisc replace dev st59h root netem rate 256kbit delay 150ms loss 1%                     # the downlink
 *   bun scripts/screenshot-link.ts bridge &
 *   sudo ip netns exec st59 sudo -u $USER LIVEKIT_API_KEY=$LIVEKIT_API_KEY LIVEKIT_API_SECRET=$LIVEKIT_API_SECRET bun scripts/screenshot-link.ts phone parts|http <jpeg>
 *
 * WebRTC in a namespace with no default route gathers no candidate, hence the route.
 */
import { AccessToken } from "livekit-server-sdk";
import { Room, RoomEvent } from "@livekit/rtc-node";

// the key of the private server's livekit.yaml
const KEY = process.env.LIVEKIT_API_KEY ?? "", SECRET = process.env.LIVEKIT_API_SECRET ?? "";
const [role, mode = "parts", shot = ""] = process.argv.slice(2);
const RUN_MS = 20_000, SHOT_AT = 3_000, DELTA_EVERY = 50;

async function token(identity: string) {
  const t = new AccessToken(KEY, SECRET, { identity, ttl: "1h" });
  t.addGrant({ roomJoin: true, room: "st59", canPublish: true, canSubscribe: true, canPublishData: true });
  return t.toJwt();
}
const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

if (role === "bridge") {
  const room = new Room();
  const got: Record<string, number> = {};
  Bun.serve({
    hostname: "10.59.0.1", port: 7993,
    async fetch(request) {
      const body = new Uint8Array(await request.arrayBuffer());
      console.log(`[bridge] POST ${body.length} bytes whole at ${Date.now()}`);
      return new Response(null, { status: 202 });
    },
  });
  room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
    const m = JSON.parse(new TextDecoder().decode(payload));
    if (m.kind === "start") void stream();
    if (m.kind === "screenshot") {
      got[m.part] = m.data.length;
      if (Object.keys(got).length === m.of) console.log(`[bridge] ${m.of} parts whole at ${Date.now()}`);
    }
  });
  await room.connect("ws://127.0.0.1:7990", await token("bridge"), { autoSubscribe: true, dynacast: false });
  console.log("[bridge] in the room");
  async function stream() {
    for (const k of Object.keys(got)) delete got[k];
    const start = Date.now();
    for (let seq = 1; Date.now() - start < RUN_MS; seq++) {
      // a delta of an answer: a few words
      await room.localParticipant!.publishData(enc({ kind: "delta", seq, t: Date.now(), text: "and then the words of the answer go " }), { reliable: true });
      await Bun.sleep(DELTA_EVERY);
    }
  }
  await new Promise(() => {});
}

if (role === "phone") {
  const jpeg = new Uint8Array(await Bun.file(shot).arrayBuffer());
  const room = new Room();
  const delays: Array<{ at: number; ms: number }> = [];
  let t0 = 0;
  room.on(RoomEvent.DataReceived, (payload: Uint8Array) => {
    const m = JSON.parse(new TextDecoder().decode(payload));
    if (m.kind === "delta") delays.push({ at: Date.now() - t0, ms: Date.now() - m.t });
  });
  await room.connect("ws://10.59.0.1:7990", await token("phone"), { autoSubscribe: true, dynacast: false });
  await Bun.sleep(1_500);
  t0 = Date.now();
  await room.localParticipant!.publishData(enc({ kind: "start" }), { reliable: true });
  await Bun.sleep(SHOT_AT);
  const sendStart = Date.now() - t0;
  if (mode === "parts") {
    // as the app did: 12,000-byte messages of base64, each awaited in turn
    const data = Buffer.from(jpeg).toString("base64");
    const size = Math.floor((12_000 - 128) / 4) * 4;
    const slices = data.match(new RegExp(`.{1,${size}}`, "g"))!;
    for (const [i, slice] of slices.entries()) {
      await room.localParticipant!.publishData(enc({ kind: "screenshot", id: "1", part: i + 1, of: slices.length, data: slice }), { reliable: true });
    }
  } else {
    const r = await fetch("http://10.59.0.1:7993/screenshot?id=1", { method: "POST", body: jpeg, headers: { authorization: "Bearer x" } });
    if (r.status !== 202) throw new Error(`status ${r.status}`);
  }
  const sendEnd = Date.now() - t0;
  await Bun.sleep(RUN_MS - SHOT_AT + 1_000);
  const after = delays.filter((d) => d.at >= sendStart).map((d) => d.ms).sort((x, y) => x - y);
  const base = delays.filter((d) => d.at < sendStart).map((d) => d.ms).sort((x, y) => x - y);
  console.log(JSON.stringify({
    mode, bytes: jpeg.length, sendMs: sendEnd - sendStart,
    beforeP50: base[base.length >> 1],
    after: { n: after.length, p50: after[after.length >> 1], p95: after[Math.floor(after.length * 0.95)], max: after.at(-1), over1s: after.filter((ms) => ms > 1_000).length },
  }));
  await room.disconnect();
  process.exit(0);
}
