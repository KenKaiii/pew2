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

/**
 * How many senders one channel tracks replay state for.
 *
 * Far above any real pairing — a person's phones and laptops. Only a device that
 * has proved it holds the key ever occupies a slot, so this is no longer a
 * defence against invented names; it bounds the state a *legitimate* pairing can
 * accumulate over a long-lived relay channel.
 */
const MAX_TRACKED_SENDERS = 64;

/**
 * The sender label used when the transport has exactly one peer.
 *
 * A point-to-point socket needs no partition: whoever is on the other end was
 * established by the transport itself, and the app never receives a proof from
 * the daemon to partition on anyway. It is therefore usable from construction —
 * but only until some device proves itself, at which point this channel is
 * demonstrably multiplexed and the unlabelled bucket is dropped for good. That
 * is what keeps the default from becoming a way around the verified set.
 */
const SOLE_SENDER = "";

/** What a `hello` proof carries, once opened. */
interface ProofBody {
  t: "proof";
  at: number;
  deviceId: string;
}

/** Per-sender replay state. Presence in the map *is* the verified flag. */
interface SenderState {
  window: ReplayWindow;
}

export class SecureChannel {
  private readonly sendKey: Uint8Array;
  private readonly receiveKey: Uint8Array;
  /**
   * One replay window per sender, not one per channel — and only for senders
   * that have proved they hold the key.
   *
   * The relay multiplexes every paired device onto the daemon's single socket,
   * so one shared window would treat a second phone's first frame as a replay of
   * the first phone's — and that phone would simply never work, silently. The
   * key is whatever the transport says about who sent a frame; on a
   * point-to-point socket there is only one sender and {@link SOLE_SENDER} is
   * used.
   *
   * Membership is the verified flag, which is the whole point. That label is
   * attacker-chosen over the relay (`?deviceId=…`), and when an unknown label
   * silently minted a fresh window, any captured frame replayed under a new name
   * — including a `session.permission` that re-approved a tool call the user
   * approved once. Entries are created only by {@link acceptHandshake}, which
   * needs a valid proof, so an attacker without the key can neither open a
   * window nor grow this map into an eviction.
   *
   * Seeded with {@link SOLE_SENDER} for point-to-point transports, which is
   * removed the moment a real device is admitted.
   */
  private readonly senders = new Map<string, SenderState>([
    [SOLE_SENDER, { window: new ReplayWindow() }],
  ]);

  /**
   * The newest proof timestamp accepted from each device.
   *
   * Survives {@link acceptHandshake} deliberately: the handshake resets replay
   * state, so without a separate monotonic clock a proof captured inside
   * {@link PROOF_SKEW_MS} could be replayed to wipe a live device's window.
   */
  private readonly lastProofAt = new Map<string, number>();

  /**
   * Devices whose proof has verified but whose handshake has not been accepted
   * yet.
   *
   * Verification and acceptance are two calls because the transports have work
   * to do between them, and a reset that any caller could reach on its own is
   * exactly the bug this class had: a cleartext `hello` naming a real device
   * wiped that device's window before anything was checked. Consuming a token
   * minted only by {@link verifyProof} makes the ordering structural instead of
   * conventional.
   */
  private readonly proven = new Set<string>();
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
  // Returns `unknown` rather than `unknown | undefined`: the union collapses to
  // `unknown` anyway, so writing it out only implies a distinction the type
  // system will not enforce. Undefined still means "rejected" — the doc above
  // is the contract, and the tests are what hold it.
  open(envelope: unknown, from = SOLE_SENDER): unknown {
    // `from` is *not* authenticated — it is whatever the transport claims about
    // the sender — so it selects among windows that already exist rather than
    // creating one. An unknown label is a sender that never proved it holds the
    // key, and its frames are refused outright: that is what stops a captured
    // frame being replayed under an invented device id, and what stops invented
    // ids evicting a real device's window.
    const sender = this.senders.get(from);
    if (!sender) return undefined;

    const message = openEnvelope(this.receiveKey, envelope);
    if (message === undefined) return undefined;

    // Touched only after the tag verifies, so an unauthenticated frame can
    // neither advance a window nor reorder eviction. Re-inserting moves this
    // sender to the end of the Map's iteration order, so the entry evicted in
    // `acceptHandshake` is always the one idle longest.
    this.senders.delete(from);
    this.senders.set(from, sender);

    if (!sender.window.accept((envelope as Envelope).ctr)) return undefined;
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
   * The timestamp bounds replay to a couple of minutes rather than forever, and
   * the per-device clock below bounds it to *once*. That matters more than it
   * used to: a proof is now what admits a sender and resets its replay window,
   * so a proof replayed inside the skew window would wipe a live device's
   * counters and reopen everything captured from it.
   *
   * Opened with the raw primitive rather than {@link open}, because a `hello` is
   * by definition a new connection whose counters restart at zero — consulting
   * the previous connection's window would reject the one frame that is allowed
   * to clear it. Authenticity is not weakened by that: it comes from the AEAD
   * tag, which cannot be produced without the key.
   */
  verifyProof(envelope: unknown, deviceId: string, now = Date.now()): boolean {
    const body = openEnvelope(this.receiveKey, envelope);
    if (typeof body !== "object" || body === null) return false;
    const proof = body as Partial<ProofBody>;
    if (proof.t !== "proof" || typeof proof.at !== "number" || !Number.isFinite(proof.at)) {
      return false;
    }
    if (Math.abs(now - proof.at) > PROOF_SKEW_MS) return false;
    // Bound to the identity the transport routed under, so a proof captured from
    // one device cannot be presented by another.
    if (proof.deviceId !== deviceId) return false;

    const last = this.lastProofAt.get(deviceId);
    if (last !== undefined && proof.at <= last) return false;

    this.lastProofAt.delete(deviceId);
    this.lastProofAt.set(deviceId, proof.at);
    this.trim(this.lastProofAt);
    this.proven.add(deviceId);
    return true;
  }

  /**
   * Admit a device that has just proved itself, and let its counters restart.
   *
   * A peer opens a new socket with a new channel, and counters are per-channel:
   * they begin again at zero every time. On the LAN that is invisible, because
   * the daemon builds a fresh channel per socket and has no history to compare
   * against. Over the relay one long-lived channel carries every device, so the
   * window remembered the highest counter from the last connection and rejected
   * the next one's first frame as a replay — permanently, until the daemon was
   * restarted.
   *
   * Returns false when {@link verifyProof} has not just accepted a proof for
   * this device, which is what keeps the reset out of reach of an unproven
   * `hello`.
   */
  acceptHandshake(deviceId: string): boolean {
    if (!this.proven.delete(deviceId)) return false;
    // This channel carries identified devices, so the unlabelled bucket is not
    // what it is for. Dropping it means a frame that arrives with no sender — a
    // relay that omitted the stamp, or a transport that forgot to pass it on —
    // is refused rather than landing in a window nobody proved.
    if (deviceId !== SOLE_SENDER) this.senders.delete(SOLE_SENDER);
    this.senders.delete(deviceId);
    this.senders.set(deviceId, { window: new ReplayWindow() });
    this.trim(this.senders);
    return true;
  }

  /**
   * Drop the least recently used entries past the cap.
   *
   * Only key holders can create entries, so this is a bound on a legitimate
   * pairing rather than a defence. An evicted device simply says `hello` again.
   */
  private trim(entries: Map<string, unknown>): void {
    while (entries.size > MAX_TRACKED_SENDERS) {
      const oldest = entries.keys().next().value;
      if (oldest === undefined) break;
      entries.delete(oldest);
    }
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
