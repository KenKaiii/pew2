/**
 * One encrypted connection.
 *
 * The primitives in `crypto.ts` are stateless; a live connection is not. It has
 * a direction, an outbound counter that must never repeat, and an inbound
 * counter that must never go backwards. Getting any of those wrong is the kind
 * of bug that still passes a round-trip test, so the state lives here once and
 * every transport shares it — the daemon's LAN server, the daemon's relay
 * client, and the app.
 *
 * Direction is decided by `role` alone. A daemon seals with the daemon-to-app
 * key and opens with the app-to-daemon key; the app does the reverse. Neither
 * can be talked into using the other's sending key, so a captured frame cannot
 * be reflected back at its own author.
 */
import {
  ReplayWindow,
  directionKey,
  open as openEnvelope,
  seal as sealEnvelope,
  type Envelope,
  type RandomBytes,
} from "./crypto.js";

export type ChannelRole = "daemon" | "app";

/**
 * How far out of step a `hello` proof's clock may be.
 *
 * Generous, because it is bounding a replay window and not measuring anything:
 * phones and laptops disagree by seconds routinely, and a tight bound would
 * reject honest clients while barely inconveniencing an attacker.
 */
const PROOF_SKEW_MS = 120_000;

/** What a `hello` proof carries, once opened. */
interface ProofBody {
  t: "proof";
  at: number;
  deviceId: string;
}

export class SecureChannel {
  private readonly sendKey: Uint8Array;
  private readonly receiveKey: Uint8Array;
  /**
   * One replay window per sender, not one per channel.
   *
   * The relay multiplexes every paired device onto the daemon's single socket,
   * so one shared window would treat a second phone's first frame as a replay of
   * the first phone's — and that phone would simply never work, silently. The
   * key is whatever the transport can say about who sent a frame; on a
   * point-to-point socket there is only one sender and the default is used.
   */
  private readonly seen = new Map<string, ReplayWindow>();
  private counter = 0;

  constructor(
    rootKey: Uint8Array,
    role: ChannelRole,
    private readonly random?: RandomBytes,
  ) {
    this.sendKey = directionKey(rootKey, role === "daemon" ? "daemon-to-app" : "app-to-daemon");
    this.receiveKey = directionKey(rootKey, role === "daemon" ? "app-to-daemon" : "daemon-to-app");
  }

  /**
   * Seal one outbound message.
   *
   * The counter is owned here rather than passed in, because a caller that
   * accidentally reused a value would produce frames the far side silently
   * discards as replays — a failure that looks like a dropped connection.
   */
  seal(message: unknown, header: { sid?: string; seq?: number } = {}): Envelope {
    return sealEnvelope(this.sendKey, message, { ...header, ctr: this.counter++ }, this.random);
  }

  /**
   * Open one inbound frame, or return `undefined`.
   *
   * Rejects anything that fails to decrypt *and* anything whose counter does not
   * advance. Both are silent: a caller cannot usefully distinguish them, and
   * saying which would tell an attacker whether their key was right.
   */
  open(envelope: unknown, from = ""): unknown | undefined {
    const message = openEnvelope(this.receiveKey, envelope);
    if (message === undefined) return undefined;

    // Checked only after the tag verifies, so an unauthenticated frame can never
    // advance a window and lock out the real peer.
    //
    // `from` partitions the windows and is *not* authenticated — it is whatever
    // the transport claims about the sender. That is sound because it cannot
    // grant anything: a wrong value at worst puts a frame in the wrong window,
    // and only ever admits frames that already carry a valid tag. A relay that
    // lied about it could cause replays within one pairing, which is strictly
    // less than the disruption it can cause by simply dropping messages.
    let window = this.seen.get(from);
    if (!window) {
      window = new ReplayWindow();
      this.seen.set(from, window);
    }
    if (!window.accept((envelope as Envelope).ctr)) return undefined;
    return message;
  }

  /**
   * A blob proving this side holds the pairing key.
   *
   * Sent alongside `hello`, which cannot itself be encrypted because it is what
   * establishes the connection. Without it, knowing the relay room id would be
   * enough to open a socket the daemon then does work for — and the room id is
   * exactly what the relay is given.
   */
  proof(deviceId: string, now = Date.now()): Envelope {
    return this.seal({ t: "proof", at: now, deviceId } satisfies ProofBody);
  }

  /**
   * Check a peer's proof.
   *
   * The timestamp bounds replay to a couple of minutes rather than forever. That
   * is deliberate and sufficient: the proof is not the security boundary, the
   * per-message AEAD is. Replaying a captured proof buys an authenticated socket
   * on which the attacker still cannot send a single readable command, because
   * every subsequent frame must be sealed with a key they do not have. The proof
   * exists so the daemon can hang up early rather than serve a peer that can
   * never talk.
   */
  verifyProof(envelope: unknown, deviceId: string, now = Date.now()): boolean {
    // Partitioned by the device it claims to be, so two phones handshaking over
    // one relay socket do not invalidate each other's proofs.
    const body = this.open(envelope, deviceId);
    if (typeof body !== "object" || body === null) return false;
    const proof = body as Partial<ProofBody>;
    return (
      proof.t === "proof" &&
      typeof proof.at === "number" &&
      Math.abs(now - proof.at) <= PROOF_SKEW_MS &&
      // Bound to the identity the transport routed under, so a proof captured
      // from one device cannot be presented by another.
      proof.deviceId === deviceId
    );
  }
}

/**
 * The routing header for a message, lifted out of its body.
 *
 * The relay keeps the ordered log that lets a reconnecting client catch up — the
 * daemon does not replay — and ordering a log means reading the order. These two
 * fields are therefore mirrored in cleartext on the envelope, and bound into the
 * AEAD so the relay can read them without being able to change them.
 *
 * Shared by both transports so a message cannot be ordered on one path and not
 * the other, which would show up as a phone that resumes correctly over Wi-Fi
 * and loses history over the relay.
 */
export function envelopeHeader(message: unknown): { sid?: string; seq?: number } {
  if (typeof message !== "object" || message === null) return {};
  const body = message as { sessionId?: unknown; seq?: unknown };
  return {
    ...(typeof body.sessionId === "string" ? { sid: body.sessionId } : {}),
    ...(typeof body.seq === "number" ? { seq: body.seq } : {}),
  };
}
