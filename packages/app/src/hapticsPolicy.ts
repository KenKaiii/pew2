/**
 * When a haptic is worth firing.
 *
 * Kept pure and free of Expo imports so the rule is testable under `bun test`,
 * which cannot parse React Native's Flow syntax — the same split as
 * `pairingLink.ts` (pure) and `pairing.ts` (native storage).
 */

/**
 * Two pulses closer together than this merge into one indistinct buzz on the
 * hardware, so the second carries no information and only drains the motor.
 *
 * This matters here because related events genuinely do land together: a failed
 * turn emits an error *and* goes idle within a few milliseconds, which would
 * otherwise be felt as a single mushy double-tap rather than one clear signal.
 */
export const MIN_GAP_MS = 80;

/**
 * @param lastFiredAt When a haptic last played, or undefined if none has.
 */
export function shouldFire(now: number, lastFiredAt: number | undefined): boolean {
  if (lastFiredAt === undefined) return true;
  // A clock that jumps backwards (NTP correction, timezone change) must not
  // mute every haptic until real time catches up.
  if (now < lastFiredAt) return true;
  return now - lastFiredAt >= MIN_GAP_MS;
}
