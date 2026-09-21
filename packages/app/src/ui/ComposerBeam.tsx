/** Native border-only beam using the installed masked-view + gradient modules.
 * The field never remounts; idle/background animations are cancelled.
 */
import { memo, useEffect, useState } from "react";
import { StyleSheet, View } from "react-native";
import MaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import Animated, { cancelAnimation, Easing, useAnimatedStyle, useSharedValue, withRepeat, withTiming } from "react-native-reanimated";
import { theme } from "../theme";
import { useAppActive } from "./useAppActive";
import { useReducedMotion } from "./useReducedMotion";

const COLORS = ["transparent", "transparent", ...theme.composer.beam, "transparent", "transparent"] as const;
export const ComposerBeam = memo(function ComposerBeam({ active }: { active: boolean }) {
  const [size, setSize] = useState({ width: 0, height: 0 });
  const foreground = useAppActive();
  const reduced = useReducedMotion();
  const phase = useSharedValue(0);
  const opacity = useSharedValue(active ? 1 : 0);
  const visibility = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const rotation = useAnimatedStyle(() => ({ transform: [{ rotate: `${phase.value * 360}deg` }] }));
  useEffect(() => {
    cancelAnimation(phase);
    opacity.value = withTiming(active ? 1 : 0, { duration: reduced ? 0 : theme.motion.base });
    if (active) phase.value = 0;
    if (active && foreground && !reduced) {
      phase.value = withRepeat(withTiming(1, { duration: theme.composer.beamDuration, easing: Easing.linear }), -1, false);
    }
    return () => { cancelAnimation(phase); cancelAnimation(opacity); };
  }, [active, foreground, reduced, phase, opacity]);
  // Covers the rectangle through a complete rotation, without corner clipping.
  const side = Math.hypot(size.width, size.height);
  return (
    <Animated.View
      pointerEvents="none" accessible={false} accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[StyleSheet.absoluteFill, visibility]}
      onLayout={({ nativeEvent: { layout } }) => setSize((prev) => prev.width === layout.width && prev.height === layout.height ? prev : { width: layout.width, height: layout.height })}
    >
      {size.width > 0 && [3, 1].map((stroke) => (
        <MaskedView
          key={stroke} style={[StyleSheet.absoluteFill, { opacity: stroke === 1 ? 0.85 : 0.18 }]}
          maskElement={<View style={[StyleSheet.absoluteFill, styles.mask, { borderWidth: stroke }]} />}
        >
          <Animated.View style={[{ position: "absolute", width: side, height: side, left: (size.width - side) / 2, top: (size.height - side) / 2 }, rotation]}>
            <LinearGradient colors={COLORS} locations={[0, 0.28, 0.38, 0.44, 0.5, 0.56, 0.62, 0.72, 1]} style={StyleSheet.absoluteFill} />
          </Animated.View>
        </MaskedView>
      ))}
    </Animated.View>
  );
});
const styles = StyleSheet.create({ mask: { borderRadius: theme.composer.radius, borderColor: "black" } });
