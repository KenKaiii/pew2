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
