/**
 * Is the app the thing the user is currently looking at?
 *
 * Looping animations here are native-driven, which means they keep their
 * display link alive independently of the JS thread — including after the app
 * is backgrounded. The orb alone drives a few hundred animated nodes, so a loop
 * left running is a genuine, measurable drain for a screen nobody can see.
 *
 * Every `Animated.loop` in the app pairs this with reduce-motion: the orb's
 * orbit and scan, the shimmer sweep, the drawer's busy pulse, the transcript's
 * working dots, and the skeleton pulse. A new repeating animation should do the
 * same.
 *
 * One subscription for the whole process rather than one per animated
 * component, for the same reason as `accessibilityState`.
 */
import { useSyncExternalStore } from "react";
import { AppState, type AppStateStatus } from "react-native";

let active = AppState.currentState === "active";
const listeners = new Set<() => void>();

function handleChange(next: AppStateStatus) {
  // Only `active` counts. `inactive` is the brief transitional state on iOS —
  // the app switcher, a system prompt, an incoming call — and during it the app
  // is either not on screen or not interactive, so it is treated exactly like
  // `background`. Doing otherwise would also restart every loop twice on a
  // single swipe away, as the state passes through `inactive` in both
  // directions.
  const nextActive = next === "active";
  // Nothing changed, so nobody is woken. Without this a swipe from `inactive`
  // to `background` — both stopped — would re-render every animated component
  // in the app for a value they would read identically.
  if (nextActive === active) return;
  active = nextActive;
  for (const listener of listeners) listener();
}

AppState.addEventListener("change", handleChange);

/** Called on every change to the answer, never when it merely restates it. */
export function subscribeAppActive(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The current answer without subscribing. */
export function isAppActive(): boolean {
  return active;
}

/** `getServerSnapshot` is the same function: there is no server on native. */
export function useAppActive(): boolean {
  return useSyncExternalStore(subscribeAppActive, isAppActive, isAppActive);
}
