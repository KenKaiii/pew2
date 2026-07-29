/**
 * Touch feedback, named by meaning rather than by waveform.
 *
 * Call sites say what happened — `sent()`, `failed()`, `finished()` — so the
 * physical vocabulary stays consistent across the app instead of every screen
 * picking its own impact style. Changing how "something failed" feels is then
 * one edit here, not twenty.
 *
 * This matters more than usual for pew2: the agent runs for minutes on another
 * machine while the phone is in a pocket. A pulse when a turn lands, an approval
 * is needed, or something breaks is the difference between a remote control and
 * a screen you have to keep watching.
 *
 * No platform check: expo-haptics maps to `navigator.vibrate` on web and checks
 * availability itself, so a desktop browser silently does nothing.
 */
import * as Haptics from "expo-haptics";
import { shouldFire } from "../hapticsPolicy";

let lastFiredAt: number | undefined;

/**
 * Play one pulse, unless it would arrive on top of the previous one.
 *
 * Deliberately not awaited, and failures are swallowed: haptics are decoration.
 * A device with the motor disabled, a denied permission, or a simulator without
 * hardware must never delay or break the action that triggered the feedback.
 */
function fire(play: () => Promise<void>): void {
  const now = Date.now();
  if (!shouldFire(now, lastFiredAt)) return;
  lastFiredAt = now;
  void play().catch(() => {});
}

export const haptics = {
  /** Any ordinary button press. The default. */
  tap: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),

  /** Moving between options in a picker, or flipping a toggle. */
  select: () => fire(() => Haptics.selectionAsync()),

  /** Committing something: sending a prompt, submitting a pairing link. */
  sent: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),

  /** A turn completed, a code scanned, a device paired. */
  finished: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),

  /** The agent is blocked and needs an answer. Distinct on purpose: this one
   *  is a request for the user, not a report about something already done. */
  attention: () => fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)),

  /** Something destructive or refused: unpairing, rejecting a permission. */
  warned: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),

  /** Something went wrong. */
  failed: () => fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),
};
