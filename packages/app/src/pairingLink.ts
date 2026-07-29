/**
 * Pairing-link validation. Pure on purpose.
 *
 * Kept free of any React Native or Expo import so it can be unit tested
 * directly — this is the logic that decides whether a scanned code is usable,
 * and it is worth far more test coverage than a module that pulls in the
 * keychain can get.
 *
 * Every rejection names what is wrong in words a user can act on: this runs at
 * the exact moment someone is holding a phone at a terminal wondering why
 * nothing happened.
 */

/** The daemon's own floor. A shorter token means a tampered or truncated URL. */
const MIN_TOKEN_LENGTH = 32;

export interface Pairing {
  /** Full URL, ready to hand to a WebSocket. */
  url: string;
  /** Host and port only. Shown in settings; never includes the secret. */
  label: string;
  /**
   * True when this goes through a relay, and so works from any network.
   * A direct link only works on the same Wi-Fi as the machine.
   */
  remote: boolean;
  /**
   * This device's id, as baked into `url`. Carried so the socket announces the
   * same identity the relay routed it under; a mismatch makes one phone look
   * like two clients.
   */
  deviceId: string;
}

export type ParseResult = { ok: true; pairing: Pairing } | { ok: false; error: string };

/**
 * @param deviceId Identifies this phone to the relay. The relay rejects a
 * connection without one, so a link pasted from the daemon (which only carries
 * the machine's own id) must have this added before it can be used.
 */
export function parsePairing(input: string, deviceId = "phone"): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: "Enter a link." };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, error: "Not a valid link. Should start with ws://" };
  }

  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    return { ok: false, error: `Need a ws:// link, got ${url.protocol}//` };
  }
  if (!url.hostname) return { ok: false, error: "Link has no address." };

  // Two shapes, one screen. A direct link carries `token` and points at the
  // machine; a relay link carries `pairing` and points at the relay, which is
  // what makes the phone work from a mobile network.
  const relayToken = url.searchParams.get("pairing");
  const token = url.searchParams.get("token") ?? relayToken;
  if (!token) {
    return { ok: false, error: "No token in that link. Run `pew2 pair` again." };
  }
  if (token.length < MIN_TOKEN_LENGTH) {
    // The daemon would reject this anyway; failing here explains why.
    return { ok: false, error: "Token too short. The link looks cut off." };
  }

  const remote = relayToken !== null;
  if (remote) {
    // A daemon-role link would put the phone on the wrong side of the relay,
    // where it would silently never see any traffic.
    url.searchParams.set("role", "app");
    // The relay answers 400 without this, which surfaces as a socket that just
    // never opens and no explanation anywhere.
    if (!url.searchParams.get("deviceId")) url.searchParams.set("deviceId", deviceId);
  }

  // `localhost` resolves to the phone itself, so a direct link to it can only
  // work in a simulator sharing the host's network. Allowed, because that is
  // the development path, but it is a common paste mistake on a real device.
  return {
    ok: true,
    pairing: {
      url: url.toString(),
      label: url.host,
      remote,
      deviceId: url.searchParams.get("deviceId") ?? deviceId,
    },
  };
}
