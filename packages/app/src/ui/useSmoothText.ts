/** Native lifecycle around the GG/assistant-ui reveal engine.
 * See ../../THIRD_PARTY_NOTICES.md and ../smoothText.ts for provenance.
 */
import { useEffect, useRef, useState } from "react";
import { AccessibilityInfo } from "react-native";
import { resetReveal, updateReveal, tickReveal, revealSettled, SETTLE_MS } from "../smoothText";
import { useAppActive } from "./useAppActive";

export function useSmoothText(text: string, identity: string, live: boolean) {
  const active = useAppActive();
  // No motion until the platform preference has actually been read.
  const [reduced, setReduced] = useState(true);
  const [screenReader, setScreenReader] = useState(true);
  useEffect(() => {
    let alive = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener("screenReaderChanged", (value) => {
      changed = true;
      if (alive) setScreenReader(value);
    });
    void AccessibilityInfo.isScreenReaderEnabled().then((value) => {
      if (alive && !changed) setScreenReader(value);
    }).catch(() => {});
    return () => { alive = false; subscription.remove(); };
  }, []);
  useEffect(() => {
    let alive = true;
    let changed = false;
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", (value) => {
      changed = true;
      if (alive) setReduced(value);
    });
    void AccessibilityInfo.isReduceMotionEnabled().then((value) => {
      if (alive && !changed) setReduced(value);
    }).catch(() => {});
    return () => { alive = false; subscription.remove(); };
  }, []);
  const enabled = live && active && !reduced && !screenReader;
  const engine = useRef(resetReveal(identity, text, 0));
  const [paint, setPaint] = useState(() => ({ identity, target: text, text, animating: false }));
  useEffect(() => {
    let alive = true;
    let frame: number | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    engine.current = updateReveal(engine.current, identity, text, Date.now(), enabled);
    function publish() {
      if (!alive) return;
      const value = engine.current;
      const shown = value.target.slice(0, value.committed);
      const animating = enabled && !revealSettled(value, Date.now());
      setPaint((prev) => prev.identity === identity && prev.target === text && prev.text === shown && prev.animating === animating
        ? prev : { identity, target: text, text: shown, animating });
    }
    function tick() {
      if (!alive) return;
      engine.current = tickReveal(engine.current, Date.now());
      publish();
      if (engine.current.committed < text.length) frame = requestAnimationFrame(tick);
      else settle = setTimeout(publish, Math.max(0, SETTLE_MS - (Date.now() - engine.current.growthAt)));
    }
    publish();
    if (enabled && engine.current.committed < text.length) frame = requestAnimationFrame(tick);
    else if (enabled) settle = setTimeout(publish, Math.max(0, SETTLE_MS - (Date.now() - engine.current.growthAt)));
    return () => {
      alive = false;
      if (frame !== undefined) cancelAnimationFrame(frame);
      if (settle !== undefined) clearTimeout(settle);
    };
  }, [text, identity, enabled]);
  // No stale prefix during cell recycling, completion, replay or accessibility
  // preference changes, even before effects have had a chance to run.
  if (!enabled || paint.identity !== identity || !text.startsWith(paint.target)) return { text, animating: false };
  return { text: paint.text, animating: paint.animating };
}
