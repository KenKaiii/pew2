/**
 * Canvas-coloured cover for the nav and composer rails.
 *
 * The overlay always uses the conversation's #111111 RGB. Its transparency lets
 * passing text remain faintly visible underneath without introducing a separate
 * grey material or a gradient that makes either rail read as another panel.
 *
 * Deliberately not a blur. There was a `BlurView` under this overlay, but an
 * overlay at 86% of the *exact colour underneath it* leaves only 14% of a
 * gentle blur visible — imperceptible, in exchange for two full-width GPU
 * passes on every frame of every scroll, on the two surfaces that are on screen
 * the entire time the app is open. Raising the alpha instead gets the same
 * result: text still fades out under the rails, and the frames are free.
 */
import { memo } from "react";
import { StyleSheet, View } from "react-native";

// The exact canvas RGB. Translucency softens content passing beneath the rails
// without the nav or dock introducing a separate material colour.
const CANVAS_OVERLAY = "rgba(17,17,17,0.92)";

interface CanvasCoverProps {
  /** Exactly the zone to cover. Nothing beyond it is touched. */
  height: number;
  /** Which screen edge the cover is attached to. */
  edge?: "top" | "bottom";
  style?: object;
}

function CanvasCoverView({ height, edge = "top", style }: CanvasCoverProps) {
  return (
    <View
      style={[
        styles.container,
        edge === "top" ? styles.top : styles.bottom,
        styles.canvasOverlay,
        { height },
        style,
      ]}
      pointerEvents="none"
    />
  );
}

// Memoized: both rails live in the root screen, which re-renders on every
// keystroke, and neither cover depends on anything that changes when it does.
// Callers pass `StyleSheet` references rather than inline objects, so the
// shallow comparison actually holds.
export const CanvasCover = memo(CanvasCoverView);

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
