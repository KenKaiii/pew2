/**
 * Canvas-coloured blur for the nav and composer rails.
 *
 * The overlay always uses the conversation's #111111 RGB. Its transparency lets
 * softened text remain faintly visible underneath without introducing a separate
 * grey material or a gradient that makes either rail read as another panel.
 */
import { StyleSheet, View } from "react-native";
import { BlurView } from "expo-blur";

/** Gentle enough to soften passing text without turning the chrome grey. */
const INTENSITY = 20;

// The exact canvas RGB. Translucency reveals only blurred content beneath it;
// the nav and dock do not introduce a separate material colour.
const CANVAS_OVERLAY = "rgba(17,17,17,0.86)";

interface ProgressiveBlurProps {
  /** Exactly the zone to cover. Nothing beyond it is touched. */
  height: number;
  /** Which screen edge the cover is attached to. */
  edge?: "top" | "bottom";
  style?: object;
}

export function ProgressiveBlur({ height, edge = "top", style }: ProgressiveBlurProps) {
  return (
    <View
      style={[styles.container, edge === "top" ? styles.top : styles.bottom, { height }, style]}
      pointerEvents="none"
    >
      <BlurView intensity={INTENSITY} tint="dark" style={StyleSheet.absoluteFill} />
      <View style={[StyleSheet.absoluteFill, styles.canvasOverlay]} pointerEvents="none" />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: "absolute",
    left: 0,
    right: 0,
    overflow: "hidden",
  },
  canvasOverlay: { backgroundColor: CANVAS_OVERLAY },
  top: { top: 0 },
  bottom: { bottom: 0 },
});
