/**
 * Shared Liquid Glass functional surface.
 *
 * iOS 26/27 gets Apple's native refractive material through expo-glass-effect,
 * including system tint, motion, contrast, and accessibility adaptations. Other
 * platforms retain a restrained blur fallback with a directional highlight and
 * material rim instead of imitating glass with an opaque grey rectangle.
 */
import { type ReactNode } from "react";
import {
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
import { useReduceTransparency } from "./accessibilityState";

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

/**
 * Resolved on first render rather than at module evaluation.
 *
 * The probe calls into a native module, and asking for it while the bundle is
 * still evaluating is exactly when a stale dev client has not registered it yet
 * — a throw there used to be cached as `false` for the entire session, silently
 * dropping every surface in the app to the more expensive blur fallback with no
 * way to recover. Deferring to first render asks once the native side is up,
 * and `undefined` (rather than `false`) as the empty state means a throw is
 * retried on the next render instead of being remembered as an answer.
 */
let nativeLiquidGlass: boolean | undefined;

function hasNativeLiquidGlass(): boolean {
  if (nativeLiquidGlass !== undefined) return nativeLiquidGlass;
  if (Platform.OS !== "ios") {
    nativeLiquidGlass = false;
    return false;
  }
  try {
    nativeLiquidGlass = isLiquidGlassAvailable();
    return nativeLiquidGlass;
  } catch {
    // A stale Expo Go/dev client can load the JS before it has the native
    // module. Left unset, so a later render asks again.
    return false;
  }
}

/**
 * Fallback platforms only: the native material draws its own highlight and
 * edge, so this stands in for it where there is none.
 *
 * Hoisted per tier because recreating the array in render pushed new props to
 * the gradient on every keystroke, the composer's glass re-rendering with the
 * draft. There are only two tiers, so both are cheaper to spell out than build.
 */
const BLUR_HIGHLIGHT: Record<"control" | "raised", readonly [string, string, string]> = {
  raised: ["rgba(255,255,255,0.22)", "rgba(255,255,255,0.035)", "rgba(255,255,255,0)"],
  control: ["rgba(255,255,255,0.14)", "rgba(255,255,255,0.035)", "rgba(255,255,255,0)"],
};
const ACCESSIBLE_FILL: Record<"control" | "raised", string> = {
  raised: "rgba(47,47,52,0.98)",
  control: "rgba(35,35,39,0.96)",
};
const HIGHLIGHT_LOCATIONS = [0, 0.42, 1] as const;
const HIGHLIGHT_START = { x: 0, y: 0 } as const;
const HIGHLIGHT_END = { x: 0.9, y: 1 } as const;

export function Glass({
  children,
  radius,
  style,
  intensity = theme.glass.intensity,
  interactive = false,
  tier = "control",
}: GlassProps) {
  const reduceTransparency = useReduceTransparency();
  const { fill, rim } = theme.glass[tier];

  if (hasNativeLiquidGlass() && !reduceTransparency) {
    // Nothing is layered over the material, deliberately. `regular` is Apple's
    // own default glass: it already carries its specular highlight, its edge,
    // and the system's tint, motion and contrast adaptations. A gradient and a
    // rim of our own on top do not make it glassier — they sit *between* the
    // material and the content as a fixed sheen that cannot respond to what is
    // behind it, which is exactly what made these controls read as painted
    // rather than as glass. The fallback below still needs both, because there
    // it has no material to sit on.
    return (
      <GlassView
        glassEffectStyle="regular"
        colorScheme="dark"
        // Every pew2 control keeps its semantic Pressable as a child. Let that
        // child own hit-testing; otherwise UIVisualEffectView can swallow taps.
        isInteractive={interactive}
        pointerEvents="box-none"
        style={[styles.native, { borderRadius: radius }, style]}
      >
        {children}
      </GlassView>
    );
  }

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
          { backgroundColor: reduceTransparency ? ACCESSIBLE_FILL[tier] : fill },
        ]}
        pointerEvents="none"
      />
      {!reduceTransparency && (
        <>
          <LinearGradient
            colors={BLUR_HIGHLIGHT[tier]}
            locations={HIGHLIGHT_LOCATIONS}
            start={HIGHLIGHT_START}
            end={HIGHLIGHT_END}
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
  /** Same clipping, no rim: the native material draws its own edge. */
  native: { overflow: "hidden" },
  lowerShade: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: "44%",
    backgroundColor: "rgba(0,0,0,0.08)",
  },
});