/**
 * The agent orb.
 *
 * A single glossy sphere is the app's one memorable device: it stands in for
 * "an agent is here", takes the provider's own colour so Claude, Codex and
 * Gemini are distinguishable at a glance, and is the only saturated thing on an
 * otherwise monochrome canvas.
 *
 * Gloss is derived from one base colour via `shade`, so adding a provider never
 * means hand-picking a gradient.
 */
import { useEffect, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { theme, shade } from "../theme";
import { useReducedMotion } from "./useReducedMotion";

interface OrbProps {
  color?: string;
  size?: number;
  /** Breathes while the agent is working. Honest signal, not decoration. */
  busy?: boolean;
}

export function Orb({ color, size = theme.size.orb, busy = false }: OrbProps) {
  const base = color ?? theme.color.orb;
  const pulse = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (!busy || reduceMotion) {
      pulse.stopAnimation();
      pulse.setValue(0);
      return;
    }

    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 900,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [busy, reduceMotion, pulse]);

  // Reduced motion still gets a state change, just a static one.
  const scale = pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.06] });
  const glow = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.35, 0.75] });

  return (
    // Purely decorative, and it lives inside tappable chips, so it must never
    // intercept a touch meant for the row behind it.
    <View style={{ width: size, height: size }} pointerEvents="none">
      <Animated.View
        style={[
          styles.glow,
          {
            borderRadius: size / 2,
            backgroundColor: base,
            opacity: busy && !reduceMotion ? glow : 0.3,
            transform: [{ scale: busy && !reduceMotion ? scale : 1 }],
          },
        ]}
      />
      <Animated.View
        style={{
          transform: [{ scale: busy && !reduceMotion ? scale : 1 }],
        }}
      >
        <LinearGradient
          // Light source top-left, falling to a saturated base: reads as a
          // sphere rather than a flat disc.
          colors={[shade(base, 0.55), base, shade(base, -0.35)]}
          locations={[0, 0.5, 1]}
          start={{ x: 0.25, y: 0 }}
          end={{ x: 0.75, y: 1 }}
          style={[styles.body, { width: size, height: size, borderRadius: size / 2 }]}
        >
          <View
            style={[
              styles.highlight,
              {
                width: size * 0.42,
                height: size * 0.28,
                borderRadius: size * 0.21,
                top: size * 0.12,
                left: size * 0.2,
              },
            ]}
          />
        </LinearGradient>
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  glow: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  body: {
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  highlight: {
    position: "absolute",
    backgroundColor: "rgba(255,255,255,0.5)",
  },
});
