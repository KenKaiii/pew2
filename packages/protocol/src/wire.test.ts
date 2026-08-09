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
import { ClientMessage, readCursors, ServerMessage, WIRE_VERSION, wireMismatch } from "./wire.js";

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

test("every message the app actually sends is accepted", () => {
  // This union became the daemon's real gate: `handler.ts` parses inbound
  // messages through it and answers anything that fails without running it. A
  // schema stricter than the app is therefore not a validation nicety, it is a
  // feature that stops working — so the shapes below are copied from the calls
  // in `useDaemon.ts` rather than from the schemas they are checking.
  const messages: unknown[] = [
    { t: "provider.capabilities", providerId: "claude-code" },
    { t: "provider.sessions", providerId: "claude-code", cwd: "/Users/someone/api" },
    { t: "provider.config", providerId: "claude-code", configId: "model", value: "opus" },
    { t: "session.config", sessionId: "s1", configId: "model", value: "opus" },
    { t: "session.config", sessionId: "s1", configId: "thinking", value: true },
    { t: "session.permission", sessionId: "s1", requestId: "r1", optionId: "allow" },
    { t: "session.prompt", sessionId: "s1", text: "hi", attachments: [] },
    // The app omits `requestId` on start: it adopts the next session for the
    // provider it is showing rather than matching one back.
    { t: "session.start", providerId: "claude-code" },
    { t: "session.start", providerId: "claude-code", cwd: "/Users/someone/api" },
    { t: "session.resume", providerId: "claude-code", agentSessionId: "a1" },
    { t: "session.resume", providerId: "claude-code", agentSessionId: "a1", cwd: "/x" },
    { t: "session.cancel", sessionId: "s1" },
    { t: "image.fetch", requestId: "u", uri: "u", sessionId: "s1" },
    { t: "workspaces", requestId: "r1" },
    { t: "workspaces", requestId: "r1", path: "/Users/someone" },
    { t: "workspace.status", sessionId: "s1", providerId: "claude-code" },
  ];

  for (const message of messages) {
    const parsed = ClientMessage.safeParse(message);
    expect({ t: (message as { t: string }).t, ok: parsed.success }).toEqual({
      t: (message as { t: string }).t,
      ok: true,
    });
  }
});

test("provider.config is one name for two shapes, one per direction", () => {
  // The app names a single choice; the daemon answers with the whole set a new
  // conversation will open with — the same split `session.config` already has.
  // Both halves have to validate in their own direction, or the empty state
  // either cannot set a model or is never told what the next prompt will use —
  // and the second of those is a pill naming a model that is not running.
  const chosen = {
    t: "provider.config",
    providerId: "claude-code",
    configId: "model",
    value: "opus",
  };
  const announced = {
    t: "provider.config",
    providerId: "claude-code",
    configOptions: [{ id: "model", name: "Model", type: "select", currentValue: "opus" }],
  };

  expect(ClientMessage.safeParse(chosen).success).toBe(true);
  expect(ServerMessage.safeParse(announced).success).toBe(true);
  // Neither passes as the other: a daemon that took an announcement for a choice
  // would write a preference with no value in it.
  expect(ServerMessage.safeParse(chosen).success).toBe(false);
  expect(ClientMessage.safeParse(announced).success).toBe(false);
});

test("a prompt keeps its attachments and defaults them when absent", () => {
  // The one field carrying bytes to disk. If validation dropped or reshaped it,
  // a prompt that says "look at the screenshot" would arrive without one.
  const withImage = ClientMessage.parse({
    t: "session.prompt",
    sessionId: "s1",
    text: "what is this",
    attachments: [{ name: "shot.png", mimeType: "image/png", data: "AAAA" }],
  });
  expect(withImage).toMatchObject({
    attachments: [{ name: "shot.png", mimeType: "image/png", data: "AAAA" }],
  });

  // Older apps send none at all, and the handler reads the field unconditionally.
  expect(ClientMessage.parse({ t: "session.prompt", sessionId: "s1", text: "hi" })).toMatchObject(
    { attachments: [] },
  );
});

test("a message missing what the daemon will use is refused", () => {
  // The point of parsing at the boundary: these used to reach a case that
  // re-checked them by hand, and anything the hand-written check forgot became
  // an undefined threaded into a spawn.
  for (const bad of [
    { t: "session.prompt", sessionId: "s1" },
    { t: "session.resume", providerId: "claude-code" },
    { t: "provider.sessions", providerId: "claude-code" },
    { t: "session.permission", sessionId: "s1", requestId: "r1" },
    { t: "image.fetch", requestId: "r1" },
    { t: "session.config", sessionId: "s1", configId: "model" },
  ]) {
    expect({ t: bad.t, ok: ClientMessage.safeParse(bad).success }).toEqual({
      t: bad.t,
      ok: false,
    });
  }
});

test("a push registration is a client message, and needs a real platform", () => {
  // Additive rather than a `WIRE_VERSION` bump: an older daemon answers
  // `unknown_message` and the app keeps its local-only banners, instead of the
  // connection being refused and working sessions going down over a
  // notification improvement.
  expect(
    ClientMessage.safeParse({
      t: "app.push",
      token: "ExponentPushToken[abc123]",
      platform: "ios",
    }).success,
  ).toBe(true);

  // The daemon branches on this to decide whether to name an Android channel,
  // and naming one the device never created means nothing is shown at all.
  expect(
    ClientMessage.safeParse({ t: "app.push", token: "ExponentPushToken[abc]", platform: "web" })
      .success,
  ).toBe(false);

  // An empty token would be sent to Expo on every finished turn for nothing.
  expect(ClientMessage.safeParse({ t: "app.push", token: "", platform: "ios" }).success).toBe(false);
});

test("cursors off a raw hello are taken only when they are usable seq numbers", () => {
  // `hello` establishes the connection, so it is read before any schema can be
  // applied to it — whatever the socket sent is a plain `unknown`. Both
  // transports answer these cursors with a catch-up replay, and a negative or
  // fractional seq would make the log slice from the wrong end and re-send a
  // whole session to a client that already had it.
  expect(readCursors({ s1: 0, s2: 41 })).toEqual({ s1: 0, s2: 41 });
  expect(readCursors({ s1: -1, s2: 2.5, s3: "9", s4: null, s5: NaN })).toEqual({});
  // A client too old to send them, or one with nothing to catch up on.
  expect(readCursors(undefined)).toEqual({});
  expect(readCursors("nonsense")).toEqual({});
  expect(readCursors(null)).toEqual({});
});
