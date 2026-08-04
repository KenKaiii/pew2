/**
 * End-to-end encryption between the phone and the daemon.
 *
 * The relay's job is to route and to order; it has never needed to *read*
 * anything. Until now it could, because the pairing token was handed to it as
 * the room key — the same secret that authorised driving every agent on the
 * machine. This module separates those two jobs:
 *
 *   - the relay is given a **room id**, derived one-way from the root key, and
 *     is therefore incapable of deriving the key back;
 *   - message content is sealed with keys the relay never sees.
 *
 * It also changes what authentication *is*. A bearer token is proved by
 * repeating it, so anyone who overhears it can repeat it too. A key is proved by
 * producing a frame that authenticates under it, which an eavesdropper cannot do
 * from having seen the room id.
 *
 * Everything here is pure and dependency-light on purpose. The same code runs in
 * Node (daemon), Hermes (phone) and workerd (relay), and three implementations
 * that agree in tests but differ in a corner is exactly how encryption fails
 * silently. React Native has no `crypto.subtle`, so a pure-JS implementation is
 * not a preference — it is the only option that is identical everywhere.
 */
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** Root key length. 256 bits, which is what XChaCha20 takes directly. */
export const ROOT_KEY_BYTES = 32;

/**
 * XChaCha20-Poly1305 nonce length.
 *
 * 192 bits is the reason this cipher was chosen over AES-GCM. Every paired
 * device shares one key, and there is no coordinator to hand out
 * non-repeating 96-bit GCM nonces — two devices picking the same one would be
 * catastrophic and invisible. At 192 bits a random nonce per frame has
 * negligible collision probability, so no coordination is needed at all.
 */
export const NONCE_BYTES = 24;

/**
 * Domain separation for HKDF.
 *
 * Versioned so a future scheme cannot be confused with this one, and distinct
 * per direction so a daemon frame cannot be replayed back at the daemon as
 * though the app had sent it.
 */
const INFO = {
  room: "pew2/room/v1",
  daemonToApp: "pew2/daemon-to-app/v1",
  appToDaemon: "pew2/app-to-daemon/v1",
} as const;

/** Which way a frame travels. Selects the key, and so cannot be forged across. */
export type Direction = "daemon-to-app" | "app-to-daemon";

/** Injectable so tests are deterministic; defaults to the platform CSPRNG. */
export type RandomBytes = (length: number) => Uint8Array;

const defaultRandom: RandomBytes = (length) => {
  const out = new Uint8Array(length);
  // `crypto.getRandomValues` is the one primitive that must come from the
  // platform: Node, workerd and Hermes (via expo-crypto) all provide it, and
  // nothing in userland can substitute for a real entropy source.
  const source = (globalThis as { crypto?: Crypto }).crypto;
  if (!source?.getRandomValues) {
    throw new Error("No secure random source: crypto.getRandomValues is unavailable");
  }
  source.getRandomValues(out);
  return out;
};

export function randomRootKey(random: RandomBytes = defaultRandom): Uint8Array {
  return random(ROOT_KEY_BYTES);
}

/**
 * A root key derived deterministically from an arbitrary secret string.
 *
 * Exists for `PEW2_TOKEN`, which lets a test or a container run without touching
 * a real home directory. Deriving a key from it keeps those runs on the *same*
 * encrypted protocol as production — the alternative is a plaintext code path
 * that only tests exercise, which is the path most likely to rot unnoticed.
 *
 * Not for user-chosen passwords: HKDF is not a password hash, and this inherits
 * exactly the entropy of what it is given.
 */
export function deriveKeyFromSecret(secret: string): Uint8Array {
  return hkdf(sha256, utf8(secret), undefined, utf8("pew2/token-key/v1"), ROOT_KEY_BYTES);
}

function derive(rootKey: Uint8Array, info: string, length: number): Uint8Array {
  if (rootKey.length !== ROOT_KEY_BYTES) {
    throw new Error(`Root key must be ${ROOT_KEY_BYTES} bytes, got ${rootKey.length}`);
  }
  // No salt: the root key is already uniformly random from a CSPRNG, which is
  // the case RFC 5869 says a salt is unnecessary for. Domain separation is
  // carried entirely by `info`.
  return hkdf(sha256, rootKey, undefined, utf8(info), length);
}

/**
 * The relay room id for a pairing.
 *
 * One-way: the relay routes on this and cannot recover the root key from it.
 * 24 bytes so the hex form is 48 characters — comfortably past the relay's
 * 32-character floor, and the same length the old bearer token used, so nothing
 * downstream has to change its expectations.
 */
export function roomId(rootKey: Uint8Array): string {
  return toHex(derive(rootKey, INFO.room, 24));
}

/** The sealing key for one direction. */
export function directionKey(rootKey: Uint8Array, direction: Direction): Uint8Array {
  return derive(
    rootKey,
    direction === "daemon-to-app" ? INFO.daemonToApp : INFO.appToDaemon,
    32,
  );
}

/**
 * A sealed frame, as it travels over the wire.
 *
 * `sid`, `seq` and `ctr` are deliberately readable. The relay keeps an ordered
 * event log so a reconnecting phone can be caught up — the daemon does not
 * provide replay itself — and ordering a log requires reading the order. They
 * are bound into the AEAD as associated data, so the relay can *read* them but
 * cannot alter them without every recipient rejecting the frame.
 */
export interface Envelope {
  t: "e";
  /** Session this belongs to, or absent for connection-level frames. */
  sid?: string;
  /** Position within the session, for the relay's replay log. */
  seq?: number;
  /** Monotonic per connection per sender. Replay protection. */
  ctr: number;
  /** base64url nonce. */
  n: string;
  /** base64url ciphertext, including the Poly1305 tag. */
  ct: string;
}

/**
 * The bytes bound into the AEAD alongside the ciphertext.
 *
 * Canonical and unambiguous: fields are separated by a character that cannot
 * appear in a session id, so no two different headers can serialise identically.
 * If they could, an attacker could move a frame between sessions while keeping
 * the tag valid.
 */
function associatedData(envelope: Pick<Envelope, "sid" | "seq" | "ctr">): Uint8Array {
  return utf8(`pew2/v2\n${envelope.sid ?? ""}\n${envelope.seq ?? ""}\n${envelope.ctr}`);
}

/**
 * Encrypt one message.
 *
 * `counter` must increase for every frame a sender emits on a connection; the
 * receiving side enforces it. That is what stops a captured frame being played
 * back later in the same conversation.
 */
export function seal(
  key: Uint8Array,
  message: unknown,
  header: { sid?: string; seq?: number; ctr: number },
  random: RandomBytes = defaultRandom,
): Envelope {
  const nonce = random(NONCE_BYTES);
  if (nonce.length !== NONCE_BYTES) {
    throw new Error(`Nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}`);
  }
  const envelope: Envelope = {
    t: "e",
    ...(header.sid === undefined ? {} : { sid: header.sid }),
    ...(header.seq === undefined ? {} : { seq: header.seq }),
    ctr: header.ctr,
    n: toBase64Url(nonce),
    ct: "",
  };
  const cipher = xchacha20poly1305(key, nonce, associatedData(envelope));
  envelope.ct = toBase64Url(cipher.encrypt(utf8(JSON.stringify(message))));
  return envelope;
}

/**
 * Decrypt one frame, or return `undefined`.
 *
 * Never throws and never explains. A caller cannot act differently on "wrong
 * key" than on "tampered", and reporting which it was tells an attacker whether
 * they have the right key — so both are one silent failure.
 */
export function open(key: Uint8Array, envelope: unknown): unknown | undefined {
  if (!isEnvelope(envelope)) return undefined;
  try {
    const nonce = fromBase64Url(envelope.n);
    if (nonce.length !== NONCE_BYTES) return undefined;
    const cipher = xchacha20poly1305(key, nonce, associatedData(envelope));
    const plaintext = cipher.decrypt(fromBase64Url(envelope.ct));
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  } catch {
    // Bad tag, bad base64, bad JSON: all the same to the caller.
    return undefined;
  }
}

/** Structural check only; authenticity is the AEAD tag's job. */
export function isEnvelope(value: unknown): value is Envelope {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.t === "e" &&
    typeof candidate.ctr === "number" &&
    Number.isSafeInteger(candidate.ctr) &&
    typeof candidate.n === "string" &&
    typeof candidate.ct === "string" &&
    (candidate.sid === undefined || typeof candidate.sid === "string") &&
    (candidate.seq === undefined || typeof candidate.seq === "number")
  );
}

/**
 * Tracks the highest counter seen, per connection.
 *
 * Strictly increasing rather than exactly-one-more: frames are ordered by the
 * transport, but a legitimate sender may skip numbers, and rejecting a gap would
 * disconnect a working client for no security gain.
 */
export class ReplayWindow {
  private highest = -1;

  /** True when this counter is new. False means replayed or out of order. */
  accept(counter: number): boolean {
    if (!Number.isSafeInteger(counter) || counter <= this.highest) return false;
    this.highest = counter;
    return true;
  }
}

// ── encoding ────────────────────────────────────────────────────────────────
// base64url rather than base64: these values travel in URLs and JSON, and `+`
// and `/` would need escaping in one of those and not the other.

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}

export function fromHex(text: string): Uint8Array {
  if (text.length % 2 !== 0) throw new Error("Hex string must have an even length");
  const out = new Uint8Array(text.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(text.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("Hex string contains a non-hex character");
    out[i] = byte;
  }
  return out;
}
