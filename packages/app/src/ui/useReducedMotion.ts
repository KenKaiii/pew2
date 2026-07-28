/**
 * Tracks the OS "Reduce Motion" setting.
 *
 * React Native 0.86 exports no `useReducedMotion` hook, so this wraps
 * AccessibilityInfo directly. Every animation in the app checks it: motion is
 * always optional, never the only signal that something changed.
 */
import { useEffect, useState } from "react";
import { AccessibilityInfo } from "react-native";

export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    let active = true;

    AccessibilityInfo.isReduceMotionEnabled()
      .then((value) => {
        if (active) setReduced(value);
      })
      // If the platform cannot report the setting, keep animations on rather
      // than letting an unhandled rejection surface as a redbox.
      .catch(() => {});

    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      setReduced,
    );

    return () => {
      active = false;
      subscription.remove();
    };
  }, []);

  return reduced;
}
