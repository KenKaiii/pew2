/**
 * When a measured height is worth telling React about.
 *
 * The composer grows with an animation, so its `onLayout` fires on every frame
 * of that animation — measured on a simulator, roughly one call per two pixels.
 * Each call set state on the root component, and everything downstream of that
 * height reacted: the thread's bottom inset, its header and footer spacers, and
 * the follow-scroll that keeps the last message visible. One wrapped line cost
 * about ten full re-renders of the app, landing on the exact frames the growth
 * animation was trying to draw. That is the composer lagging the caret.
 *
 * Nothing downstream needs the intermediate values. The thread needs to end up
 * clear of the composer; it does not need to track it frame by frame, and doing
 * so was never visible as anything except the stutter. So the height is
 * reported once it stops moving.
 */

/**
 * How long a height must hold still before it counts as settled.
 *
 * Two frames at 60Hz. Long enough that a continuing animation always cancels
 * it, short enough that the thread's inset arrives while the composer is still
 * visibly finishing — so the last message is never seen behind the glass.
 */
export const SETTLE_MS = 32;

/**
 * Whether a newly measured height should be reported now, deferred, or ignored.
 *
 * Ignoring an unchanged height is what stops a settled layout from rescheduling
 * itself forever: `onLayout` fires again for reasons that have nothing to do
 * with growth — a keyboard frame, a parent re-layout — and each of those would
 * otherwise restart the timer and eventually re-report a height React already
 * has.
 */
export function heightAction(
  current: number,
  measured: number,
): "ignore" | "report-now" | "defer" {
  if (measured === current) return "ignore";
  // The first real measurement, before anything has been reported. Deferring it
  // would leave the thread using its analytic fallback for two extra frames at
  // launch, which is visible as the last message sitting under the composer.
  if (current === 0) return "report-now";
  return "defer";
}
