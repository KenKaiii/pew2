/**
 * One pairing, one device.
 *
 * A pairing link never expires — that is what lets a phone reconnect after a
 * reboot without scanning anything. The cost used to be that the link stayed a
 * bearer credential forever: a QR caught on camera, or a URL pasted into a
 * screenshot, admitted anyone who found it for as long as the pairing lived.
 *
 * So the link is single-use *for claiming*. The first device to complete a
 * handshake is written into `pairing.json`, and from then on only that device
 * is admitted. The phone that already paired keeps working forever; a copy of
 * the same link on someone else's phone is refused.
 *
 * What this does and does not defend against, stated plainly because the
 * difference matters:
 *
 *   - **Defends** against a leaked link — recording, screenshot, shoulder-surf.
 *     The attacker holds the key but arrives second, under a device id of their
 *     own, and is turned away.
 *   - **Does not defend** against an attacker who both holds the key *and*
 *     knows the claimed device id, because proofs are derived from the shared
 *     root key and can therefore be minted for any name. The device id is not a
 *     second secret; it is trust-on-first-use. Rotation remains the only true
 *     revocation, which is why the refusal message names it.
 *   - **Does not defend** against an attacker who arrives *before* the real
 *     phone. Whoever claims first, wins — so a link that leaked before it was
 *     ever used must be rotated, not merely re-scanned.
 */

/** The outcome of offering a device id to a pairing. */
export type ClaimDecision =
  /** Admitted. `claim` is set when this handshake is what took the pairing. */
  | { ok: true; claim?: string }
  /** Refused, with the reason to send back to the app. */
  | { ok: false; message: string };

/**
 * The message a refused device sees.
 *
 * Names the fix, because the honest recovery path for a phone that legitimately
 * lost its id — a reinstall clears the keychain — is identical to what an
 * attacker sees, and the user is the one who can tell those apart.
 */
export const REFUSED_MESSAGE =
  "This pairing is already in use by another device. A pairing link works once: " +
  "if this is your phone and you reinstalled the app, run `pew2 pair --rotate` on " +
  "your machine and scan the new code.";

/**
 * Decide whether a device may use this pairing.
 *
 * Pure on purpose. The persistence and the transports differ; the rule must
 * not, or the LAN socket and the relay end up enforcing two different things
 * and the weaker one is the only one that matters.
 */
export function decideClaim(claimedBy: string | undefined, deviceId: string): ClaimDecision {
  // An empty id is never a claim. The callers already reject one, but a blank
  // stored value must not become a wildcard that matches the next blank.
  if (!deviceId) return { ok: false, message: REFUSED_MESSAGE };

  // Unclaimed: this device takes it.
  if (!claimedBy) return { ok: true, claim: deviceId };

  // Already ours — the ordinary case, every reconnect for the life of the
  // pairing.
  if (claimedBy === deviceId) return { ok: true };

  return { ok: false, message: REFUSED_MESSAGE };
}
