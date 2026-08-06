/**
 * Who is allowed into a pairing room, as a pure decision.
 *
 * Split out of the Durable Object so it can be tested without the Workers
 * runtime: the rules here are the relay's entire access control, and "it
 * deployed and seemed fine" is not a way to check them.
 *
 * The relay cannot authenticate anybody, and is not meant to. Traffic is sealed
 * end to end; what the relay is given is the room id, which is derived one way
 * from the root key and is not the key. So these rules assume the party opening
 * a socket may be someone who learned a room id and nothing else, and they
 * narrow what such a party can do:
 *
 *   - a token that could never have been minted by `pew2` never names a room
 *   - a retired token cannot leave a device sitting in an empty room, looking
 *     connected to a machine that will never answer
 *   - one leaked token cannot pile up unbounded sockets
 *   - a stranger cannot take a working daemon's place in the room
 */

/**
 * The pairing token is the room key: [REDACTED] presenting it joins the room and
 * sees its traffic. Enforce enough entropy that a token cannot be guessed or
 * typed by hand. Generate with `crypto.randomUUID()` twice, or 32 random hex
 * chars — never a human-chosen string.
 *
 * This is a floor, not authentication. What keeps a leaked room id from being a
 * leaked conversation is the end-to-end encryption above it: everything the
 * relay carries is ciphertext it cannot read.
 */
export const MIN_PAIRING_TOKEN_LENGTH = 32;

/**
 * Tokens are hex, because that is the only thing `pew2` mints.
 *
 * Rejecting anything else costs nothing and means a mistyped or probing request
 * is refused before it can name a Durable Object at all — which matters because
 * naming one is what brings it into existence.
 */
const PAIRING_TOKEN = /^[0-9a-f]+$/i;

/**
 * Sockets one room will hold.
 *
 * A pairing is one desktop plus that person's handful of devices, so this sits
 * far above any real use and only bounds what a leaked token can accumulate.
 */
export const MAX_SOCKETS_PER_ROOM = 16;

export type Role = "daemon" | "app";

/**
 * Rejected with a status and a reason, or admitted — possibly evicting first.
 *
 * The admitted case carries the validated `role` and `deviceId` back out, so the
 * caller attaches the values this function actually checked rather than casting
 * the raw query parameters and asserting they must be fine.
 */
export type Admission =
  | { ok: false; status: 400 | 409 | 429; reason: string }
  | { ok: true; role: Role; deviceId: string; evictDaemons: boolean };

/** Is this string shaped like a token `pew2` could have produced? */
export function isPairingToken(token: string | null): token is string {
  return (
    token !== null && token.length >= MIN_PAIRING_TOKEN_LENGTH && PAIRING_TOKEN.test(token)
  );
}

/**
 * How long an attached daemon may be silent before it is treated as gone.
 *
 * Measured from the hibernation auto-response, which is the only thing the relay
 * learns about a socket without waking up. Three missed keepalives at the
 * daemon's 25s interval, plus room for a slow network: comfortably above the
 * interval, or a healthy machine on a bad connection becomes evictable.
 *
 * The cost of the upper bound is reconnect latency. A laptop that changes
 * network leaves a socket the runtime has not yet noticed, and its own retry is
 * refused until that socket looks dead — so a blip can take this long to heal
 * rather than the second it used to. That is the trade for a room that a
 * stranger holding only the room id cannot take from the machine that lives in
 * it, and the daemon retries throughout with a 30s ceiling.
 *
 * Shared with the room's idle sweep, which must not tolerate more silence than
 * this.
 */
export const DAEMON_STALE_MS = 90_000;

/**
 * Decide whether a connection may join a room.
 *
 * `daemons` and `total` describe the room as it is right now, counted from the
 * sockets the object still holds. `daemonLastSeen` is when the attached daemon
 * last showed signs of life, in epoch milliseconds, or null when there is none.
 */
export function admit(input: {
  role: string | null;
  deviceId: string | null;
  daemons: number;
  total: number;
  daemonLastSeen?: number | null;
  now?: number;
}): Admission {
  const role = input.role;
  const deviceId = input.deviceId;

  if (role !== "daemon" && role !== "app") {
    return { ok: false, status: 400, reason: "role must be 'daemon' or 'app'" };
  }
  if (!deviceId) {
    return { ok: false, status: 400, reason: "deviceId required" };
  }
  if (input.total >= MAX_SOCKETS_PER_ROOM) {
    return { ok: false, status: 429, reason: "too many connections for this pairing" };
  }

  if (role === "daemon") {
    // One desktop per pairing, and eviction is decided by liveness rather than
    // by arrival order.
    //
    // Not "first claim wins": a dropped socket stays attached until the runtime
    // notices, and the daemon reconnects within a second of a network blip, so
    // refusing the newcomer outright would lock a machine out of its own room
    // behind exponential backoff every time a laptop changed network.
    //
    // Not "newest wins" either, which is what this used to do. Nobody opening
    // this socket has proved anything — the room id is derived from the root key
    // and is not the key — so a stranger who learned it could evict the real
    // daemon over and over. They pay no backoff and the evicted daemon does, so
    // they win that race every time and keep winning it: not eavesdropping,
    // which the encryption prevents, but a permanent outage with no visible
    // cause and nothing the user can do about it.
    //
    // Silence is the one thing the relay can judge without a key. A daemon still
    // answering keepalives keeps its place; one that has gone quiet is past
    // saving anyway, and evicting it is what makes reconnection reliable.
    if (input.daemons > 0) {
      const lastSeen = input.daemonLastSeen;
      const now = input.now ?? Date.now();
      if (lastSeen != null && now - lastSeen <= DAEMON_STALE_MS) {
        return { ok: false, status: 409, reason: "a live daemon is already connected" };
      }
    }
    return { ok: true, role, deviceId, evictDaemons: input.daemons > 0 };
  }

  if (input.daemons === 0) {
    // No desktop here, so there is nothing to talk to.
    //
    // This is what makes rotation actually take effect: the room named by a
    // retired token has no daemon in it, so a device still holding that token is
    // turned away outright rather than sitting in an empty room looking
    // connected. It also stops an unrecognised token from holding a socket open.
    // Both sides reconnect with backoff, so an app arriving during a daemon
    // restart simply retries.
    return { ok: false, status: 409, reason: "no daemon connected for this pairing" };
  }

  return { ok: true, role, deviceId, evictDaemons: false };
}
