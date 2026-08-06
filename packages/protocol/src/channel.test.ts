/**
 * Connection-level encryption state.
 *
 * The primitives are tested in `crypto.test.ts`. What is tested here is the
 * stateful part — direction, counters, replay — because those are the failures
 * that still pass a round-trip test and only show up as a connection that
 * mysteriously stops working.
 */
import { expect, test } from "bun:test";
import { SecureChannel } from "./channel.js";
import { ROOT_KEY_BYTES } from "./crypto.js";

const ROOT = new Uint8Array(ROOT_KEY_BYTES).fill(5);
const OTHER = new Uint8Array(ROOT_KEY_BYTES).fill(6);

/** The two ends of one pairing. */
function pair() {
  return { daemon: new SecureChannel(ROOT, "daemon"), app: new SecureChannel(ROOT, "app") };
}

test("each side reads what the other sends", () => {
  const { daemon, app } = pair();

  expect(app.open(daemon.seal({ t: "providers", providers: [] }))).toEqual({
    t: "providers",
    providers: [],
  });
  expect(daemon.open(app.seal({ t: "session.prompt", text: "hi" }))).toEqual({
    t: "session.prompt",
    text: "hi",
  });
});

test("a side cannot read its own traffic", () => {
  // The point of separate keys per direction. If a daemon could open a
  // daemon-sealed frame, so could anyone replaying one back at it.
  const { daemon, app } = pair();

  expect(daemon.open(daemon.seal({ t: "providers" }))).toBeUndefined();
  expect(app.open(app.seal({ t: "session.cancel" }))).toBeUndefined();
});

test("a different pairing cannot read anything", () => {
  const { daemon } = pair();
  const stranger = new SecureChannel(OTHER, "app");

  expect(stranger.open(daemon.seal({ t: "providers" }))).toBeUndefined();
});

test("a captured frame cannot be replayed on the same connection", () => {
  // The attack the counter exists for: re-sending a captured "approve this"
  // later in the same conversation.
  const { daemon, app } = pair();
  const frame = app.seal({ t: "session.permission", optionId: "allow" });

  expect(daemon.open(frame)).toEqual({ t: "session.permission", optionId: "allow" });
  expect(daemon.open(frame)).toBeUndefined();
});

test("counters advance per sender and do not collide across directions", () => {
  const { daemon, app } = pair();

  // Both sides start at zero and count independently; sharing a counter would
  // make one side's traffic look like replays of the other's.
  expect(daemon.seal({ t: "a" }).ctr).toBe(0);
  expect(daemon.seal({ t: "b" }).ctr).toBe(1);
  expect(app.seal({ t: "c" }).ctr).toBe(0);
  expect(app.seal({ t: "d" }).ctr).toBe(1);
});

test("a frame that fails to decrypt does not advance the replay window", () => {
  // Otherwise anyone able to send garbage could push the counter past the real
  // peer's next frame and silently disconnect them — a denial of service that
  // needs no key at all.
  const { daemon, app } = pair();
  const stranger = new SecureChannel(OTHER, "app");

  const legitimate = app.seal({ t: "session.prompt", text: "first" });
  // Forged, and numbered far ahead.
  const forged = stranger.seal({ t: "session.prompt", text: "attack" });
  for (let i = 0; i < 50; i++) stranger.seal({ t: "noise" });

  expect(daemon.open(forged)).toBeUndefined();
  expect(daemon.open(legitimate)).toEqual({ t: "session.prompt", text: "first" });
});

test("two devices on one multiplexed socket do not cancel each other out", () => {
  // The relay fans every paired device onto the daemon's single connection, so
  // their counters are independent and both start at zero. One shared replay
  // window would read the second phone's first frame as a replay of the first
  // phone's, and that phone would never work — silently, with no error anywhere.
  const daemon = new SecureChannel(ROOT, "daemon");
  const phoneA = new SecureChannel(ROOT, "app");
  const phoneB = new SecureChannel(ROOT, "app");

  expect(daemon.open(phoneA.seal({ t: "a0" }), "phone-a")).toEqual({ t: "a0" });
  expect(daemon.open(phoneA.seal({ t: "a1" }), "phone-a")).toEqual({ t: "a1" });
  expect(daemon.open(phoneB.seal({ t: "b0" }), "phone-b")).toEqual({ t: "b0" });
  expect(daemon.open(phoneB.seal({ t: "b1" }), "phone-b")).toEqual({ t: "b1" });

  // And replay is still caught within each device's own stream.
  const repeat = phoneA.seal({ t: "a2" });
  expect(daemon.open(repeat, "phone-a")).toEqual({ t: "a2" });
  expect(daemon.open(repeat, "phone-a")).toBeUndefined();
});

test("two devices can each prove themselves over one socket", () => {
  // Same problem in the handshake: proofs are sealed frames too, so without
  // per-device windows the second phone to connect could never authenticate.
  const daemon = new SecureChannel(ROOT, "daemon");
  const phoneA = new SecureChannel(ROOT, "app");
  const phoneB = new SecureChannel(ROOT, "app");

  expect(daemon.verifyProof(phoneA.proof("phone-a"), "phone-a")).toBe(true);
  expect(daemon.verifyProof(phoneB.proof("phone-b"), "phone-b")).toBe(true);
});

test("a flood of invented senders cannot exhaust memory", () => {
  // The partition key comes from the sender's own claimed device id, so it is
  // attacker-controlled over the relay. An unbounded map would grow one entry
  // per made-up name until the daemon fell over — a denial of service needing
  // no key, only the room id.
  const daemon = new SecureChannel(ROOT, "daemon");
  const app = new SecureChannel(ROOT, "app");

  for (let i = 0; i < 5_000; i++) {
    expect(daemon.open(app.seal({ t: "noise", i }), `invented-${i}`)).toEqual({ t: "noise", i });
  }

  // Still bounded, and still working for a real device afterwards.
  expect(daemon.open(app.seal({ t: "real" }), "phone-a")).toEqual({ t: "real" });
  const repeat = app.seal({ t: "again" });
  expect(daemon.open(repeat, "phone-a")).toEqual({ t: "again" });
  expect(daemon.open(repeat, "phone-a")).toBeUndefined();
});

test("an active device keeps its replay window while idle ones are evicted", () => {
  // Eviction is least-recently-used, so the device actually talking is the last
  // to lose protection — not the first.
  const daemon = new SecureChannel(ROOT, "daemon");
  const app = new SecureChannel(ROOT, "app");

  const busy = app.seal({ t: "first" });
  expect(daemon.open(busy, "phone-busy")).toEqual({ t: "first" });

  // Comfortably past the 64-sender cap, or nothing is ever evicted and this
  // test passes with the eviction logic deleted.
  let firstOfFlood: ReturnType<typeof app.seal> | undefined;
  for (let i = 0; i < 500; i++) {
    const frame = app.seal({ t: "noise", i });
    if (i === 0) firstOfFlood = frame;
    daemon.open(frame, `other-${i}`);
    // Keep the busy device in use, so it stays the most recent.
    daemon.open(app.seal({ t: "keepalive", i }), "phone-busy");
  }

  // Its window survived: the original frame is still recognised as a replay.
  expect(daemon.open(busy, "phone-busy")).toBeUndefined();

  // And an idle one did not. The very first frame of the flood is replayed here:
  // with its window evicted it is accepted a second time, which is exactly the
  // trade being made — the alternative is unbounded memory — and it grants
  // nothing on its own, because every frame still needs a valid tag.
  //
  // Replaying the *same* frame is what makes this discriminating. A freshly
  // sealed one carries a higher counter and would be accepted whether or not
  // the window still existed.
  expect(daemon.open(firstOfFlood, "other-0")).toEqual({ t: "noise", i: 0 });
});

test("session headers survive the round trip", () => {
  // The relay orders its replay log by these, so they have to arrive intact as
  // well as being tamper-evident.
  const { daemon, app } = pair();
  const sealed = daemon.seal({ t: "session.event", payload: { n: 1 } }, { sid: "s1", seq: 12 });

  expect(sealed.sid).toBe("s1");
  expect(sealed.seq).toBe(12);
  expect(app.open(sealed)).toEqual({ t: "session.event", payload: { n: 1 } });
});

test("a proof from the paired device is accepted", () => {
  const { daemon, app } = pair();
  expect(daemon.verifyProof(app.proof("phone-1"), "phone-1")).toBe(true);
});

test("a proof from a different pairing is refused", () => {
  // The whole point: holding the relay room id must not be enough to be served.
  // The room id is derived one-way from the key, so the relay has one and not
  // the other.
  const { daemon } = pair();
  const stranger = new SecureChannel(OTHER, "app");

  expect(daemon.verifyProof(stranger.proof("phone-1"), "phone-1")).toBe(false);
});

test("a proof is bound to the device the transport routed under", () => {
  // Stops a proof captured from one device being presented by another.
  const { daemon, app } = pair();
  expect(daemon.verifyProof(app.proof("phone-1"), "phone-2")).toBe(false);
});

test("a stale or future-dated proof is refused", () => {
  // Bounds replay to a couple of minutes. Not the security boundary — that is
  // the per-message AEAD — but it stops a proof captured last week being useful.
  const { daemon, app } = pair();
  const at = Date.now();

  expect(daemon.verifyProof(app.proof("phone-1", at), "phone-1", at + 10_000)).toBe(true);
  expect(daemon.verifyProof(app.proof("phone-1", at), "phone-1", at + 600_000)).toBe(false);
  expect(daemon.verifyProof(app.proof("phone-1", at), "phone-1", at - 600_000)).toBe(false);
});

test("a malformed or absent proof is refused rather than thrown", () => {
  // These arrive from the network before anything is trusted, so a throw here
  // is a crash a stranger can cause.
  const { daemon } = pair();

  for (const bad of [undefined, null, {}, "proof", 42, { t: "e", ctr: 0, n: "AA", ct: "AA" }]) {
    expect(daemon.verifyProof(bad, "phone-1")).toBe(false);
  }
});

test("a non-proof message cannot be used as a proof", () => {
  // A correctly sealed frame is not automatically an assertion of identity;
  // accepting any decryptable blob would let an ordinary prompt authenticate.
  const { daemon, app } = pair();
  expect(daemon.verifyProof(app.seal({ t: "session.cancel" }), "phone-1")).toBe(false);
});

test("a peer that reconnects is not mistaken for a replay", () => {
  // The relay carries every device on one long-lived daemon channel, while each
  // phone builds a fresh channel per socket — so its counters restart at zero
  // on every reconnect. Without forgetting the last connection, the daemon
  // rejected that first frame as a replay and never recovered: the app sat on
  // "getting the list of agents" and `pew2 pair` waited for a phone that had
  // already arrived. A daemon restart was the only cure.
  const key = new Uint8Array(32).fill(7);
  const daemon = new SecureChannel(key, "daemon");

  const first = new SecureChannel(key, "app");
  expect(daemon.verifyProof(first.proof("phone"), "phone")).toBe(true);
  expect(daemon.open(first.seal({ t: "ping" }), "phone")).toEqual({ t: "ping" });

  // The phone drops and comes back with a brand new channel, counting from 0.
  const second = new SecureChannel(key, "app");
  daemon.resetSender("phone");
  expect(daemon.verifyProof(second.proof("phone"), "phone")).toBe(true);
  expect(daemon.open(second.seal({ t: "ping" }), "phone")).toEqual({ t: "ping" });
});

test("resetting one device does not reopen replay for another", () => {
  // Two phones share the relay's single channel. One reconnecting must not
  // clear the other's protection.
  const key = new Uint8Array(32).fill(9);
  const daemon = new SecureChannel(key, "daemon");
  const other = new SecureChannel(key, "app");

  const frame = other.seal({ t: "ping" });
  expect(daemon.open(frame, "other")).toEqual({ t: "ping" });

  daemon.resetSender("phone");
  // Still refused: the replayed frame belongs to a sender that never reset.
  expect(daemon.open(frame, "other")).toBeUndefined();
});

test("replay is still refused within one connection", () => {
  // The reset happens only on `hello`. Inside a live connection a repeated
  // frame must still be dropped, or the fix would remove replay protection
  // rather than scope it.
  const key = new Uint8Array(32).fill(3);
  const daemon = new SecureChannel(key, "daemon");
  const app = new SecureChannel(key, "app");

  const frame = app.seal({ t: "ping" });
  expect(daemon.open(frame, "phone")).toEqual({ t: "ping" });
  expect(daemon.open(frame, "phone")).toBeUndefined();
});
