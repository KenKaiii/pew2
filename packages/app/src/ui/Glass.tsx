/**
 * Shared Liquid Glass functional surface.
 *
 * iOS 26/27 gets Apple's native refractive material through expo-glass-effect,
 * including system tint, motion, contrast, and accessibility adaptations. Other
 * platforms retain a restrained blur fallback with a directional highlight and
 * material rim instead of imitating glass with an opaque grey rectangle.
 */
import { type ReactNode, useEffect, useState } from "react";
import {
  AccessibilityInfo,
  Platform,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { LinearGradient } from "expo-linear-gradient";
import { theme } from "../theme";

interface GlassProps {
  children: ReactNode;
  /** Corner radius. Must be on the clipping material, not a child fill. */
  radius: number;
  style?: StyleProp<ViewStyle>;
  intensity?: number;
  /** Native touch illumination for surfaces that are themselves controls. */
  interactive?: boolean;
  /**
   * `control` for buttons, pills and chips; `raised` for the composer and
   * approval dock, which need stronger legibility over scrolling content.
   */
  tier?: "control" | "raised";
}

function hasNativeLiquidGlass(): boolean {
  if (Platform.OS !== "ios") return false;
  try {
    return isLiquidGlassAvailable();
  } catch {
    // A stale Expo Go/dev client can load the JS before it has the native module.
    return false;
  }
}

const nativeLiquidGlassAvailable = hasNativeLiquidGlass();

export function Glass({
  children,
  radius,
  style,
  intensity = theme.glass.intensity,
  interactive = false,
  tier = "control",
}: GlassProps) {
  const [reduceTransparency, setReduceTransparency] = useState(false);
  const { fill, rim } = theme.glass[tier];
  const highlight =
    tier === "raised" ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.14)";
  const nativeRim =
    tier === "raised" ? "rgba(255,255,255,0.34)" : "rgba(255,255,255,0.28)";

  useEffect(() => {
    // Optional-called: `isReduceTransparencyEnabled` is an iOS API, and a
    // platform without it (react-native-web) otherwise throws during mount and
    // takes the whole tree down — a blank screen rather than a missing blur.
    void AccessibilityInfo.isReduceTransparencyEnabled?.().then(setReduceTransparency);
    const subscription = AccessibilityInfo.addEventListener(
      "reduceTransparencyChanged",
      setReduceTransparency,
    );
    return () => subscription.remove();
  }, []);

  if (nativeLiquidGlassAvailable && !reduceTransparency) {
    return (
      <GlassView
        glassEffectStyle="regular"
        colorScheme="dark"
        // Every pew2 control keeps its semantic Pressable as a child. Let that
        // child own hit-testing; otherwise UIVisualEffectView can swallow taps.
        isInteractive={interactive}
        pointerEvents="box-none"
        style={[styles.material, { borderRadius: radius, borderColor: nativeRim }, style]}
      >
        <LinearGradient
          colors={[highlight, "rgba(255,255,255,0.025)", "rgba(255,255,255,0)"]}
          locations={[0, 0.42, 1]}
          start={{ x: 0, y: 0 }}
          end={{ x: 0.9, y: 1 }}
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
        {children}
      </GlassView>
    );
  }

  const accessibleFill =
    tier === "raised" ? "rgba(47,47,52,0.98)" : "rgba(35,35,39,0.96)";

  return (
    <View style={[styles.material, { borderRadius: radius, borderColor: rim }, style]}>
      {!reduceTransparency && (
        <BlurView
          intensity={intensity}
          tint="dark"
          style={StyleSheet.absoluteFill}
          pointerEvents="none"
        />
      )}
      <View
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: reduceTransparency ? accessibleFill : fill },
        ]}
        pointerEvents="none"
      />
      {!reduceTransparency && (
        <>
          <LinearGradient
            colors={[highlight, "rgba(255,255,255,0.035)", "rgba(255,255,255,0)"]}
            locations={[0, 0.42, 1]}
            start={{ x: 0, y: 0 }}
            end={{ x: 0.9, y: 1 }}
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <View style={styles.lowerShade} pointerEvents="none" />
        </>
      )}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  /**
   * The rim is a border on the clipping view itself, never a second
   * absolutely-positioned bordered child. Two rounded rects at identical
   * coordinates are anti-aliased independently, so their curves disagree by a
   * fraction of a pixel and the edge reads as soft or doubled. One layer means
   * one rounded path: the platform strokes the same curve it clips to.
   */
  material: { overflow: "hidden", borderWidth: StyleSheet.hairlineWidth },
  lowerShade: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "44%",
    backgroundColor: "rgba(0,0,0,0.08)",
  },
});