/**
 * The encryption layer.
 *
 * Cryptography fails silently: code that encrypts with a broken scheme looks
 * exactly like code that encrypts with a sound one, and the bug surfaces as
 * somebody reading a stranger's messages rather than as an exception. So these
 * tests assert the properties the design depends on, not just that a round trip
 * works — a round trip would pass with the cipher removed entirely.
 */
import { expect, test } from "bun:test";
import {
  NONCE_BYTES,
  ROOT_KEY_BYTES,
  ReplayWindow,
  directionKey,
  fromBase64Url,
  fromHex,
  isEnvelope,
  open,
  randomRootKey,
  roomId,
  seal,
  toBase64Url,
  toHex,
} from "./crypto.js";

const KEY_A = new Uint8Array(ROOT_KEY_BYTES).fill(7);
const KEY_B = new Uint8Array(ROOT_KEY_BYTES).fill(9);

/** Deterministic bytes, so a test can assert on an exact nonce. */
function counterRandom(start = 0) {
  let n = start;
  return (length: number) => {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i++) out[i] = (n + i) & 0xff;
    n += length;
    return out;
  };
}

test("a sealed message comes back exactly as it went in", () => {
  const key = directionKey(KEY_A, "app-to-daemon");
  const message = {
    t: "session.prompt",
    text: "hello — ünicode, \u0000 nulls, and \"quotes\"",
    nested: { list: [1, 2, 3], flag: true, missing: null },
  };

  const sealed = seal(key, message, { sid: "s1", seq: 4, ctr: 1 });
  expect(open(key, sealed)).toEqual(message);
});

test("the ciphertext does not contain the plaintext", () => {
  // The one property that would make all of this pointless if it were false.
  const key = directionKey(KEY_A, "app-to-daemon");
  const secret = "SECRET-MARKER-DO-NOT-LEAK";
  const sealed = seal(key, { t: "session.prompt", text: secret }, { ctr: 1 });

  const wire = JSON.stringify(sealed);
  expect(wire).not.toContain(secret);
  // Nor the message type, which would leak what the user is doing.
  expect(wire).not.toContain("session.prompt");
});

test("a frame cannot be opened with the wrong key", () => {
  const sealed = seal(directionKey(KEY_A, "app-to-daemon"), { t: "x" }, { ctr: 1 });
  expect(open(directionKey(KEY_B, "app-to-daemon"), sealed)).toBeUndefined();
});

test("a daemon frame cannot be replayed back at the daemon", () => {
  // Why the two directions use different keys. With one shared key, an attacker
  // could capture a frame the daemon sent and return it as though the app had
  // sent it — and it would authenticate.
  const outbound = seal(directionKey(KEY_A, "daemon-to-app"), { t: "providers" }, { ctr: 1 });
  expect(open(directionKey(KEY_A, "app-to-daemon"), outbound)).toBeUndefined();
});

test("tampering with the readable header is detected", () => {
  // `sid`, `seq` and `ctr` are in cleartext so the relay can order its replay
  // log. They are bound into the AEAD precisely so the relay cannot *change*
  // them — moving a frame into another session, or replaying it under a higher
  // counter, must invalidate the tag.
  const key = directionKey(KEY_A, "daemon-to-app");
  const sealed = seal(key, { t: "session.event", payload: 1 }, { sid: "s1", seq: 4, ctr: 2 });

  expect(open(key, { ...sealed, sid: "s2" })).toBeUndefined();
  expect(open(key, { ...sealed, seq: 5 })).toBeUndefined();
  expect(open(key, { ...sealed, ctr: 3 })).toBeUndefined();
  // Unchanged, it still opens — so the rejections above are the binding working,
  // not the frame being broken to begin with.
  expect(open(key, sealed)).toEqual({ t: "session.event", payload: 1 });
});

test("tampering with the ciphertext or nonce is detected", () => {
  const key = directionKey(KEY_A, "daemon-to-app");
  const sealed = seal(key, { t: "providers", providers: [] }, { ctr: 1 });

  const flipped = fromBase64Url(sealed.ct);
  flipped[0]! ^= 0x01;
  expect(open(key, { ...sealed, ct: toBase64Url(flipped) })).toBeUndefined();

  const otherNonce = new Uint8Array(NONCE_BYTES).fill(1);
  expect(open(key, { ...sealed, n: toBase64Url(otherNonce) })).toBeUndefined();

  // Truncation, which removes the Poly1305 tag rather than corrupting it.
  expect(open(key, { ...sealed, ct: sealed.ct.slice(0, 8) })).toBeUndefined();
});

test("malformed input is refused rather than thrown", () => {
  // These arrive from the network, so anything that throws here is a crash a
  // stranger can trigger.
  const key = directionKey(KEY_A, "daemon-to-app");
  for (const bad of [
    null,
    undefined,
    42,
    "string",
    {},
    { t: "e" },
    { t: "e", ctr: 1, n: "!!!not base64!!!", ct: "abc" },
    { t: "e", ctr: 1.5, n: "AA", ct: "AA" },
    { t: "e", ctr: 1, n: toBase64Url(new Uint8Array(8)), ct: "AA" },
    { t: "not-an-envelope", ctr: 1, n: "AA", ct: "AA" },
  ]) {
    expect(open(key, bad)).toBeUndefined();
  }
});

test("every seal uses a fresh nonce", () => {
  // Nonce reuse under the same key breaks XChaCha20-Poly1305 outright. This is
  // the assumption that lets every paired device share one key without any
  // coordination between them.
  const key = directionKey(KEY_A, "app-to-daemon");
  const nonces = new Set<string>();
  for (let i = 0; i < 500; i++) nonces.add(seal(key, { t: "ping", i }, { ctr: i }).n);
  expect(nonces.size).toBe(500);
});

test("identical messages produce different ciphertexts", () => {
  // Follows from the fresh nonce, and is what stops an observer recognising a
  // repeated command by its ciphertext alone.
  const key = directionKey(KEY_A, "app-to-daemon");
  const a = seal(key, { t: "session.cancel" }, { ctr: 1 });
  const b = seal(key, { t: "session.cancel" }, { ctr: 2 });
  expect(a.ct).not.toBe(b.ct);
});

test("the room id is stable, one-way, and long enough for the relay", () => {
  const room = roomId(KEY_A);

  // Stable: the same pairing must reach the same room on every reconnect.
  expect(roomId(KEY_A)).toBe(room);
  expect(roomId(KEY_B)).not.toBe(room);

  // The relay requires at least 32 hex characters, and validates the alphabet.
  expect(room).toMatch(/^[0-9a-f]{48}$/);

  // One-way: the relay is given this, so it must not contain the key it came
  // from. A substring check is crude but catches the catastrophic mistake of
  // deriving by concatenation rather than by hashing.
  expect(room).not.toContain(toHex(KEY_A));
});

test("the room id and the message keys are independent", () => {
  // The relay knows the room id. If a message key could be derived from it, the
  // relay could read everything and this whole layer would be theatre.
  const room = roomId(KEY_A);
  const toApp = toHex(directionKey(KEY_A, "daemon-to-app"));
  const toDaemon = toHex(directionKey(KEY_A, "app-to-daemon"));

  expect(toApp).not.toBe(toDaemon);
  expect(room).not.toContain(toApp.slice(0, 16));
  expect(room).not.toContain(toDaemon.slice(0, 16));
});

test("derivation is pinned to fixed vectors", () => {
  // Changing any of these breaks every existing pairing, silently, at the next
  // connection. Pinning them makes that a failing test rather than a support
  // request. Regenerate deliberately if the scheme is ever versioned up.
  const key = fromHex("00".repeat(32));
  expect(roomId(key)).toBe("138b8c2ed6a1ad86ffb6e84c023630967f8539b2aab4770f");
  expect(toHex(directionKey(key, "daemon-to-app")).slice(0, 32)).toBe(
    "09f1840f5c7e4d0b3389ccd964bbbe87",
  );
  expect(toHex(directionKey(key, "app-to-daemon")).slice(0, 32)).toBe(
    "d5c6fc8300c2bcded2ff769cf9e5d87a",
  );
});

test("a root key of the wrong size is refused", () => {
  // A short key would still "work" — and be trivially weaker than it looks.
  expect(() => roomId(new Uint8Array(16))).toThrow("32 bytes");
  expect(() => directionKey(new Uint8Array(64), "daemon-to-app")).toThrow("32 bytes");
});

test("generated root keys are the right size and not constant", () => {
  const first = randomRootKey();
  const second = randomRootKey();
  expect(first).toHaveLength(ROOT_KEY_BYTES);
  expect(toHex(first)).not.toBe(toHex(second));
});

test("the replay window accepts forward progress and rejects repeats", () => {
  const window = new ReplayWindow();

  expect(window.accept(0)).toBe(true);
  expect(window.accept(1)).toBe(true);
  // Gaps are fine: the transport orders frames, and a sender may skip numbers.
  // Disconnecting a working client over a gap buys no security.
  expect(window.accept(9)).toBe(true);

  // The actual attack: a captured frame played back into the same connection.
  expect(window.accept(9)).toBe(false);
  expect(window.accept(5)).toBe(false);
  expect(window.accept(-1)).toBe(false);
  expect(window.accept(1.5)).toBe(false);
  expect(window.accept(Number.NaN)).toBe(false);

  // And it keeps working afterwards.
  expect(window.accept(10)).toBe(true);
});

test("base64url round trips, and avoids characters that need escaping", () => {
  // These values travel in both URLs and JSON; `+` and `/` are safe in one and
  // not the other, which is the whole reason for the url-safe alphabet.
  const random = counterRandom(200);
  for (const length of [0, 1, 2, 3, 24, 32, 255]) {
    const bytes = random(length);
    const encoded = toBase64Url(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect([...fromBase64Url(encoded)]).toEqual([...bytes]);
  }
});

test("hex round trips and rejects malformed input", () => {
  expect(toHex(new Uint8Array([0, 15, 16, 255]))).toBe("000f10ff");
  expect([...fromHex("000f10ff")]).toEqual([0, 15, 16, 255]);
  expect(() => fromHex("abc")).toThrow("even length");
  expect(() => fromHex("zz")).toThrow("non-hex");
});

test("isEnvelope accepts what seal produces", () => {
  // The structural guard and the producer must agree, or valid frames get
  // dropped as malformed at the receiver.
  const key = directionKey(KEY_A, "daemon-to-app");
  expect(isEnvelope(seal(key, { t: "x" }, { ctr: 1 }))).toBe(true);
  expect(isEnvelope(seal(key, { t: "x" }, { sid: "s", seq: 2, ctr: 1 }))).toBe(true);
});
