/**
 * Frosted surface used by every floating control.
 *
 * Blur alone over a near-black canvas reads as flat grey, so each surface pairs
 * a BlurView with a translucent fill and a hairline rim — the fill gives it
 * body, the rim catches "light" and lifts it off the canvas.
 *
 * All three values come from theme.glass, so every frosted control resolves to
 * the same colour. That consistency is what sells the material.
 */
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { theme } from "../theme";

interface GlassProps {
  children: ReactNode;
  /** Corner radius. Must be on the clipping container, not the blur. */
  radius: number;
  style?: StyleProp<ViewStyle>;
  intensity?: number;
  /**
   * `control` for buttons, pills and chips; `raised` for the composer, which
   * is the primary input and reads a step brighter than everything around it.
   */
  tier?: "control" | "raised";
}

export function Glass({
  children,
  radius,
  style,
  intensity = theme.glass.intensity,
  tier = "control",
}: GlassProps) {
  const { fill, rim } = theme.glass[tier];
  return (
    <View style={[{ borderRadius: radius, overflow: "hidden" }, style]}>
      {/* The three decorative layers are pointerEvents="none" so they never
          intercept a tap meant for the control rendered inside. */}
      <BlurView
        intensity={intensity}
        tint="dark"
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <View
        style={[StyleSheet.absoluteFill, { backgroundColor: fill }]}
        pointerEvents="none"
      />
      <View
        style={[styles.edge, { borderRadius: radius, borderColor: rim }]}
        pointerEvents="none"
      />
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  edge: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    borderWidth: StyleSheet.hairlineWidth,
  },
});
