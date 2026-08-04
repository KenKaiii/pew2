/**
 * Protocol version negotiation.
 *
 * The failure this guards against is not a crash. Encryption arrived in wire 2,
 * so a wire 1 app connecting to a wire 2 daemon receives frames it cannot
 * decrypt — and without an explicit check that looks exactly like a broken
 * daemon: the socket opens, and then nothing ever appears.
 */
import { expect, test } from "bun:test";
import { directionKey, isEnvelope, seal } from "./crypto.js";
import { ClientMessage, ServerMessage, WIRE_VERSION, wireMismatch } from "./wire.js";

test("an outdated hello still parses, so its sender can be told why", () => {
  // The subtle one. Pinning `wire` to a literal in the schema would make this
  // fail validation and be dropped as malformed — leaving the one client that
  // most needs "update the app" as the only client that cannot be told.
  const parsed = ClientMessage.safeParse({
    t: "hello",
    wire: 1,
    role: "app",
    deviceId: "phone",
    cursors: {},
  });

  expect(parsed.success).toBe(true);
});

test("a version mismatch names which side is behind", () => {
  // "Update the app" and "update pew2 on your computer" are different actions,
  // and sending someone after the wrong one wastes their evening.
  expect(wireMismatch(WIRE_VERSION)).toBeUndefined();

  const older = wireMismatch(WIRE_VERSION - 1);
  expect(older).toContain("Update the app");

  const newer = wireMismatch(WIRE_VERSION + 1);
  expect(newer).toContain("Update pew2 on your computer");

  // Both quote the versions, so a bug report carries the numbers.
  expect(older).toContain(`v${WIRE_VERSION}`);
  expect(newer).toContain(`v${WIRE_VERSION}`);
});

test("a missing or malformed version is refused rather than assumed current", () => {
  // Assuming the current version would let a garbled or hostile hello through
  // into the encrypted path, where it would fail far less legibly.
  for (const bad of [undefined, null, "2", 2.5, Number.NaN, {}]) {
    expect(wireMismatch(bad)).toBeDefined();
  }
});

test("an encrypted envelope is a valid client message", () => {
  // Every message carrying user content arrives as one of these, so it has to
  // pass the same validation as any other frame.
  const parsed = ClientMessage.safeParse({
    t: "e",
    sid: "s1",
    seq: 3,
    ctr: 1,
    n: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    ct: "AAAA",
  });

  expect(parsed.success).toBe(true);
});

test("a connection-level envelope needs no session", () => {
  // `hello` proofs and other connection-scoped frames belong to no session, and
  // must not be forced to invent one.
  const parsed = ClientMessage.safeParse({ t: "e", ctr: 0, n: "AA", ct: "AA" });
  expect(parsed.success).toBe(true);
});

test("an envelope without a counter is refused", () => {
  // The counter is what makes replay detectable; a frame without one cannot be
  // checked at all.
  expect(ClientMessage.safeParse({ t: "e", n: "AA", ct: "AA" }).success).toBe(false);
  expect(ClientMessage.safeParse({ t: "e", ctr: -1, n: "AA", ct: "AA" }).success).toBe(false);
  expect(ClientMessage.safeParse({ t: "e", ctr: 1.5, n: "AA", ct: "AA" }).success).toBe(false);
});

test("what seal produces passes both validators, in both directions", () => {
  // The schema here and `isEnvelope` in crypto.ts are independent descriptions
  // of the same shape, and a real frame has to satisfy both — the schema on
  // arrival, `isEnvelope` before decryption. If they drift, valid traffic is
  // dropped as malformed, which reads as a flaky connection rather than a bug.
  const key = directionKey(new Uint8Array(32).fill(3), "daemon-to-app");

  for (const header of [{ ctr: 0 }, { sid: "s1", seq: 7, ctr: 42 }]) {
    const sealed = seal(key, { t: "session.event" }, header);
    expect(isEnvelope(sealed)).toBe(true);
    expect(ClientMessage.safeParse(sealed).success).toBe(true);
    // Both unions carry it: envelopes travel in both directions.
    expect(ServerMessage.safeParse(sealed).success).toBe(true);
  }
});
