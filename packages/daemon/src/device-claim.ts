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

/**
 * The id every app used to call itself.
 *
 * `pew2 pair` bakes a literal `deviceId=phone` into the printed link so the URL
 * is valid standalone, and apps built before the claim gate kept it rather than
 * substituting their own. So a phone paired on an older build claims its pairing
 * under this name — and once the user updates, their app introduces itself with
 * a real random id, does not match, and is refused from its own pairing.
 *
 * Treated as unclaimed for that reason: it identifies no particular device, so
 * it is not evidence that any device holds this pairing. The next handshake
 * claims it properly. The window this opens is one connection wide and only for
 * pairings made before the gate existed, which were bearer credentials in full
 * anyway — whereas the alternative is every existing user locked out by an
 * update, with a refusal that reads like an accusation.
 */
const PLACEHOLDER_DEVICE_ID = "phone";

/**
 * Does this stored claim name a real device?
 *
 * The placeholder does not, so persistence must be willing to overwrite it —
 * otherwise the claim on disk stays `phone` forever and every updated app is
 * refused on the next restart, which is the failure this whole allowance exists
 * to prevent.
 */
export function isRealClaim(claimedBy: string | undefined): claimedBy is string {
  return Boolean(claimedBy) && claimedBy !== PLACEHOLDER_DEVICE_ID;
}

/**
 * The prefix `pew2 pair`'s own watching socket identifies itself with.
 *
 * Lives here rather than in the CLI because both sides need it and they must
 * not disagree: the CLI decides what to send, the daemon decides what that
 * means, and a copy in each is a rule that can drift.
 */
export const CLI_DEVICE_PREFIX = "pew2-cli@";

/**
 * Is this the local CLI watching, rather than a phone?
 *
 * Prefix rather than an exact string because the hostname is appended, and the
 * `@` is what keeps it unforgeable-by-accident: a phone's id is a name and a
 * uuid, so it cannot collide. This is not a security boundary either way —
 * anything reaching this point already proved it holds the pairing key.
 */
export function isLocalWatcher(deviceId: string): boolean {
  return deviceId.startsWith(CLI_DEVICE_PREFIX);
}

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

  // `pew2 pair` opens a socket of its own to notice the phone arriving, and it
  // has to prove itself or the daemon seals nothing to it. Proving made it a
  // *device*, so it took the very pairing it was printing — and the phone that
  // then scanned the QR was refused as the second device, told to run
  // `pew2 pair --rotate`, which minted a fresh code and claimed that one too.
  // The user is locked out by the command whose only job is letting them in.
  //
  // Admitted, never recorded: this id watches, and ownership stays with
  // whichever phone actually turns up.
  if (isLocalWatcher(deviceId)) return { ok: true };

  // A device still calling itself `phone` is running a build from before the
  // gate. Refusing it would lock out someone who has not updated yet, on a
  // pairing that was never single-device to begin with; admitting it without
  // recording the claim keeps the placeholder from becoming the owner and
  // locking out that same person the moment they do update.
  if (deviceId === PLACEHOLDER_DEVICE_ID) return { ok: true };

  // Unclaimed, or claimed only by the placeholder an older app left behind.
  if (!claimedBy || claimedBy === PLACEHOLDER_DEVICE_ID) return { ok: true, claim: deviceId };

  // Already ours — the ordinary case, every reconnect for the life of the
  // pairing.
  if (claimedBy === deviceId) return { ok: true };

  return { ok: false, message: REFUSED_MESSAGE };
}
