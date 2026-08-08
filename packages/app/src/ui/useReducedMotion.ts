/**
 * Tracks the OS "Reduce Motion" setting.
 *
 * React Native 0.86 exports no `useReducedMotion` hook. The implementation now
 * lives in `accessibilityState`, which holds one subscription and one cached
 * answer for the whole app rather than one per mounted component; this module
 * stays as the name the animation code already imports.
 */
export { useReducedMotion } from "./accessibilityState";
