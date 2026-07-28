/**
 * Frosted surface used by every floating control.
 *
 * Blur alone over a true-black canvas reads as flat grey, so each surface pairs
 * a BlurView with a translucent tint and a hairline top edge — the tint gives
 * it body, the edge catches "light" and separates it from the canvas.
 */
import type { ReactNode } from "react";
import { StyleSheet, View, type StyleProp, type ViewStyle } from "react-native";
import { BlurView } from "expo-blur";

interface GlassProps {
  children: ReactNode;
  /** Corner radius. Must be on the clipping container, not the blur. */
  radius: number;
  style?: StyleProp<ViewStyle>;
  intensity?: number;
  /** Slightly brighter fill for controls that should sit above their neighbours. */
  raised?: boolean;
}

export function Glass({
  children,
  radius,
  style,
  intensity = 40,
  raised = false,
}: GlassProps) {
  return (
    <View style={[{ borderRadius: radius, overflow: "hidden" }, style]}>
      <BlurView intensity={intensity} tint="dark" style={StyleSheet.absoluteFill} />
      <View
        style={[
          StyleSheet.absoluteFill,
          {
            backgroundColor: raised
              ? "rgba(255,255,255,0.12)"
              : "rgba(255,255,255,0.07)",
          },
        ]}
      />
      <View
        style={[
          styles.edge,
          { borderRadius: radius },
        ]}
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
    borderColor: "rgba(255,255,255,0.14)",
  },
});
