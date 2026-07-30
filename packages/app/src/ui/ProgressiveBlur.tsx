/**
 * A blur that fades out instead of stopping.
 *
 * The goal is the iOS "variable blur" feel — text dissolving as it slides
 * under the nav, so the nav stays legible while the thread keeps the full
 * screen height. True variable blur needs per-pixel alpha masks, which Expo
 * does not give us; the naive substitute (stacking strips at increasing
 * intensities) chops every glyph into bands of different blur radii and reads
 * as pixelation.
 *
 * What actually looks smooth: ONE blur at a single radius, so no glyph ever
 * crosses a band boundary, and the *fade* carried by a tint gradient on top.
 * The eye reads the tint's falloff as the blur easing out — without a single
 * visible seam.
 */
import { StyleSheet } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";

/** How far below the nav the fade reaches, in points. */
export const NAV_FADE = 36;

/** Uniform, and deliberately gentle: frost, not smear. */
const INTENSITY = 24;

interface ProgressiveBlurProps {
  /** Total height of the fading region: solid cover plus NAV_FADE. */
  height: number;
  /**
   * Height that stays fully covered — the status bar plus the nav. The fade
   * begins exactly here: percentages of the whole container would let text
   * stay readable well below the nav, which is exactly the gap this prop
   * exists to remove.
   */
  solidHeight: number;
  style?: object;
}

export function ProgressiveBlur({ height, solidHeight, style }: ProgressiveBlurProps) {
  // Where the fade starts, as a fraction of the container: the nav's bottom
  // edge, not an arbitrary midpoint.
  const fadeStart = Math.min(1, solidHeight / height);
  return (
    <BlurView
      intensity={INTENSITY}
      tint="dark"
      style={[styles.container, { height }, style]}
      pointerEvents="none"
    >
      {/* The progression lives here: near-opaque through the nav, fully clear
          at the bottom of the fade. Text dissolves into this gradient; the
          blur underneath keeps it soft the whole way. */}
      <LinearGradient
        colors={["rgba(10,10,11,0.85)", "rgba(10,10,11,0.4)", "rgba(10,10,11,0)"]}
        locations={[0, fadeStart, 1]}
        style={StyleSheet.absoluteFill}
      />
    </BlurView>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    overflow: "hidden",
  },
});
