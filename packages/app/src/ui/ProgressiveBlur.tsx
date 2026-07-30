/**
 * Frosted cover for an edge zone, easing within its own bounds.
 *
 * Content scrolls behind the nav (and behind the composer), and this keeps
 * those controls legible over it. Two rules learned the hard way:
 *
 * - ONE uniform blur. Stacked strips at different radii chop glyphs into
 *   mismatched bands, which reads as pixelation.
 * - Contained to the zone. Any fade tail beyond the nav's bottom edge (or
 *   above the composer) dims content that has not even arrived yet. The
 *   softness lives INSIDE the band: the tint eases from nearly opaque at the
 *   screen edge to light at the inner edge, so the band is not a solid slab
 *   but never reaches into the thread.
 */
import { StyleSheet } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";

/** Uniform, and deliberately gentle: frost, not smear. */
const INTENSITY = 24;

const STRONG = "rgba(10,10,11,0.88)";
const MID = "rgba(10,10,11,0.55)";
const LIGHT = "rgba(10,10,11,0.28)";

interface ProgressiveBlurProps {
  /** Exactly the zone to cover. Nothing beyond it is touched. */
  height: number;
  /** Which screen edge the strong side sits on. */
  edge?: "top" | "bottom";
  style?: object;
}

export function ProgressiveBlur({ height, edge = "top", style }: ProgressiveBlurProps) {
  // The ease stays inside the band: strong at the screen edge, light — but
  // never clear — at the inner edge, so the boundary is soft without a tail.
  const colors: [string, string, string] =
    edge === "top" ? [STRONG, MID, LIGHT] : [LIGHT, MID, STRONG];

  return (
    <BlurView
      intensity={INTENSITY}
      tint="dark"
      style={[styles.container, edge === "top" ? styles.top : styles.bottom, { height }, style]}
      pointerEvents="none"
    >
      <LinearGradient colors={colors} style={StyleSheet.absoluteFill} />
    </BlurView>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    overflow: "hidden",
  },
  top: { top: 0 },
  bottom: { bottom: 0 },
});
