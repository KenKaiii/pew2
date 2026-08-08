/**
 * One app-wide answer for the two accessibility settings the UI reacts to.
 *
 * Both were previously read per component instance: every `Glass` and every
 * animated view fired its own `AccessibilityInfo` query and registered its own
 * listener. With a dozen glass surfaces on screen that is a dozen duplicate
 * bridge round trips during mount, and — worse — a dozen components whose
 * *first frame* renders against the default rather than the real setting.
 *
 * For reduce-transparency that first frame is a visible bug, not a nicety: a
 * surface that paints its translucent fill before the query resolves shows the
 * content behind it, and only corrects on the next render. Caching the resolved
 * value at module scope means the first mount pays the query and every mount
 * after it — including every time a dropdown is opened — reads the settled
 * answer synchronously.
 *
 * Queries are fired once at import so the answers are usually already in hand by
 * the time anything renders.
 */
import { useSyncExternalStore } from "react";
import { AccessibilityInfo } from "react-native";

type Setting = "reduceMotion" | "reduceTransparency";

const values: Record<Setting, boolean> = {
  reduceMotion: false,
  reduceTransparency: false,
};

const listeners: Record<Setting, Set<() => void>> = {
  reduceMotion: new Set(),
  reduceTransparency: new Set(),
};

function publish(setting: Setting, next: boolean) {
  if (values[setting] === next) return;
  values[setting] = next;
  for (const listener of listeners[setting]) listener();
}

function subscribe(setting: Setting) {
  return (listener: () => void) => {
    listeners[setting].add(listener);
    return () => {
      listeners[setting].delete(listener);
    };
  };
}

/**
 * Optional-called and catch-guarded throughout: `isReduceTransparencyEnabled`
 * is an iOS API, and a platform without it (react-native-web) would otherwise
 * throw during module evaluation and take the whole tree down — a blank screen
 * rather than a missing blur.
 */
function prime() {
  AccessibilityInfo.isReduceMotionEnabled?.()
    .then((value) => publish("reduceMotion", value))
    .catch(() => {});
  AccessibilityInfo.isReduceTransparencyEnabled?.()
    .then((value) => publish("reduceTransparency", value))
    .catch(() => {});
}

prime();

// One subscription per setting for the life of the process, rather than one per
// mounted component. These are never removed because the settings stay relevant
// for exactly as long as the app is running.
AccessibilityInfo.addEventListener("reduceMotionChanged", (value) =>
  publish("reduceMotion", value),
);
AccessibilityInfo.addEventListener("reduceTransparencyChanged", (value) =>
  publish("reduceTransparency", value),
);

const subscribeMotion = subscribe("reduceMotion");
const subscribeTransparency = subscribe("reduceTransparency");

const getMotion = () => values.reduceMotion;
const getTransparency = () => values.reduceTransparency;

/** Tracks the OS "Reduce Motion" setting. Every animation in the app checks it. */
export function useReducedMotion(): boolean {
  return useSyncExternalStore(subscribeMotion, getMotion, getMotion);
}

/** Tracks the OS "Reduce Transparency" setting. Every glass surface checks it. */
export function useReduceTransparency(): boolean {
  return useSyncExternalStore(subscribeTransparency, getTransparency, getTransparency);
}
