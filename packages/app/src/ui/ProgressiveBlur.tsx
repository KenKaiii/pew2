/**
 * A blur that fades out instead of stopping.
 *
 * A plain BlurView behind the nav is a frosted *block*: content scrolling
 * underneath hits a hard edge and the screen reads as two stacked panels.
 * Stacking thin blur strips whose intensity falls away gives the iOS
 * "variable blur" feel — text dissolves as it approaches the nav instead of
 * being cut off — so the nav stays legible over anything while the
 * conversation keeps the full height of the screen.
 *
 * The ramp is quadratic and the ceiling deliberately low: a strong blur reads
 * as a dirty smear over text, and large steps between strips band into visible
 * lines. Many small, quickly-decaying strips are what make it look like one
 * smooth gradient rather than stacked glass.
 */
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { LinearGradient } from "expo-linear-gradient";

/** How far below the nav the fade reaches, in points. */
export const NAV_FADE = 36;

const STRIPS = 12;
const MAX_INTENSITY = 42;

/**
 * Intensity per strip, top (under the nav) to bottom (clear). `(1 - t)^2`
 * spends most of the budget near the nav and lands at ~0, so the lower edge
 * feathers into the thread with no visible cutoff.
 */
const RAMP = Array.from({ length: STRIPS }, (_, i) => {
  const t = i / (STRIPS - 1);
  return Math.round(MAX_INTENSITY * (1 - t) * (1 - t));
});

interface ProgressiveBlurProps {
  /** Total height of the fading region: nav height plus NAV_FADE. */
  height: number;
  style?: StyleProp<ViewStyle>;
}

export function ProgressiveBlur({ height, style }: ProgressiveBlurProps) {
  const strip = height / STRIPS;
  return (
    <View style={[styles.container, { height }, style]} pointerEvents="none">
      {RAMP.map((intensity, index) => (
        <BlurView
          key={index}
          intensity={intensity}
          tint="dark"
          // A strip's blur samples beyond its own band; the slight overlap
          // keeps adjacent strips from meeting at a visible seam.
          style={{
            position: "absolute",
            top: strip * index - 1,
            left: 0,
            right: 0,
            height: strip + 2,
          }}
        />
      ))}
      {/* A gentle tint, eased out: sells the gradient without darkening the
          nav area into a slab. */}
      <LinearGradient
        colors={["rgba(10,10,11,0.42)", "rgba(10,10,11,0.12)", "rgba(10,10,11,0)"]}
        locations={[0, 0.55, 1]}
        style={StyleSheet.absoluteFill}
      />
    </View>
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
