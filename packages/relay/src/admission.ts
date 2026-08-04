/**
 * Who is allowed into a pairing room, as a pure decision.
 *
 * Split out of the Durable Object so it can be tested without the Workers
 * runtime: the rules here are the relay's entire access control, and "it
 * deployed and seemed fine" is not a way to check them.
 *
 * The relay cannot authenticate anybody. The pairing token is a bearer secret
 * and there is no end-to-end encryption yet, so none of this pretends to stop
 * someone who has the token. What it does is narrow the blast radius of the
 * things that are cheap to get wrong:
 *
 *   - a token that could never have been minted by `pew2` never names a room
 *   - a retired token cannot leave a device sitting in an empty room, looking
 *     connected to a machine that will never answer
 *   - one leaked token cannot pile up unbounded sockets
 */

/**
 * The pairing token is the room key: [REDACTED] presenting it joins the room and
 * sees its traffic. Enforce enough entropy that a token cannot be guessed or
 * typed by hand. Generate with `crypto.randomUUID()` twice, or 32 random hex
 * chars — never a human-chosen string.
 *
 * This is a floor, not authentication. Before shipping to real users this must
 * be paired with end-to-end encryption, so that a leaked token exposes only
 * ciphertext the relay itself cannot read.
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
 * Decide whether a connection may join a room.
 *
 * `daemons` and `total` describe the room as it is right now, counted from the
 * sockets the object still holds.
 */
export function admit(input: {
  role: string | null;
  deviceId: string | null;
  daemons: number;
  total: number;
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
    // One desktop per pairing, and the newest connection is the live one.
    //
    // Deliberately *not* "first claim wins". A dropped socket stays attached
    // until the runtime notices, and the daemon reconnects within a second of a
    // network blip — so refusing the newcomer would lock a machine out of its
    // own room behind exponential backoff every time a laptop changed network.
    // Evicting instead makes reconnection reliable, and costs little that
    // matters: anyone able to open this socket already holds the token, and the
    // real daemon reconnects and takes the room straight back.
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
