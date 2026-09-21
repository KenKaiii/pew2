/** Adapted from Jakub Antalik's official thinking-orbs React Native port,
 * commit de85557ca220332586d070d8788c0e1d6e877a0d (MIT).
 * See THIRD_PARTY_NOTICES.md. Geometry is the pinned upstream engine, not a
 * hand-drawn approximation. Changes: existing lifecycle hooks, decorative
 * accessibility (the activity row owns its label), and a 30 fps recording cap.
 */
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { View } from "react-native";
import { Canvas, PaintStyle, Picture, Skia, createPicture, type SkPicture } from "@shopify/react-native-skia";
import { MODE_FRAMES, resolvePreset, type OrbState } from "thinking-orbs/engine";
import { useAppActive } from "./useAppActive";
import { useReducedMotion } from "./useReducedMotion";

export const ThinkingOrb = memo(function ThinkingOrb({ state, paused = false }: { state: OrbState; paused?: boolean }) {
  const active = useAppActive();
  const reduced = useReducedMotion();
  const size = 20;
  const [picture, setPicture] = useState<SkPicture | null>(null);
  const paints = useMemo(() => ({ fill: Skia.Paint(), stroke: Skia.Paint() }), []);
  const rgba = useRef(new Float32Array(4)).current;
  const { mode, speed, opts } = useMemo(() => resolvePreset(state, size), [state]);
  useEffect(() => {
    const { fill, stroke } = paints;
    fill.setAntiAlias(true);
    stroke.setAntiAlias(true);
    stroke.setStyle(PaintStyle.Stroke);
    const build = MODE_FRAMES[mode];
    const setInk = (paint: typeof fill, white: number, alpha: number) => {
      const grey = Math.round((1 - Math.min(1, Math.max(0, white))) * 255) / 255;
      rgba[0] = grey; rgba[1] = grey; rgba[2] = grey; rgba[3] = alpha;
      paint.setColor(rgba);
    };
    const record = (time: number) => {
      const frame = build(size, time, opts);
      setPicture(createPicture((canvas) => {
        for (const line of frame.lines) {
          setInk(stroke, line.white, line.a ?? 1);
          stroke.setStrokeWidth(line.w);
          canvas.drawLine(line.x1, line.y1, line.x2, line.y2, stroke);
        }
        for (const dot of frame.dots) {
          setInk(fill, dot.white, dot.a ?? 1);
          canvas.drawCircle(dot.x, dot.y, dot.r, fill);
        }
      }, Skia.XYWHRect(0, 0, size, size)));
    };
    const now = () => performance.now() / 1000;
    record(reduced ? 0.6 : now() * speed);
    if (paused || reduced || !active) return;
    let raf = 0;
    let running = true;
    let last = performance.now();
    const tick = (timestamp: number) => {
      if (!running) return;
      if (timestamp - last >= 1000 / 30) {
        record(timestamp / 1000 * speed);
        last = timestamp;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => { running = false; cancelAnimationFrame(raf); };
  }, [active, reduced, paused, mode, speed, opts, paints, rgba]);
  return (
    <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" pointerEvents="none" style={{ width: size, height: size }}>
      <Canvas style={{ width: size, height: size }}>
        {picture ? <Picture picture={picture} /> : null}
      </Canvas>
    </View>
  );
});
