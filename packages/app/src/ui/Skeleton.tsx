/**
 * Placeholders shown while content is on its way.
 *
 * The drawer's history arrives provider by provider, and without this it reads
 * as "empty" for exactly long enough to feel broken — the worst possible lie a
 * loading state can tell.
 */
import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { useReducedMotion } from "./useReducedMotion";

/** One pulsing block. Compose these into the shape of the coming content. */
export function Skeleton({ style }: { style?: ViewStyle | ViewStyle[] }) {
  const reduceMotion = useReducedMotion();
  const opacity = useRef(new Animated.Value(0.4)).current;

  useEffect(() => {
    // Pulsing is the only signal that this is a wait, not a blank. With reduced
    // motion a static block still reads as placeholder rather than content.
    if (reduceMotion) return;
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.85, duration: 650, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 0.4, duration: 650, useNativeDriver: true }),
      ]),
    );
    pulse.start();
    return () => pulse.stop();
  }, [opacity, reduceMotion]);

  return <Animated.View style={[styles.block, { opacity }, style]} />;
}

/** The drawer's history list while agents answer what they have on disk. */
export function HistorySkeleton() {
  return (
    <View accessibilityLabel="Loading chat history">
      {[0, 1, 2].map((row) => (
        <View key={row} style={styles.historyRow}>
          <Skeleton style={{ width: `${68 - row * 12}%`, height: 15 }} />
          <Skeleton style={{ width: "28%", height: 11, marginTop: theme.space(1.5) }} />
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  block: {
    backgroundColor: theme.color.surfacePressed,
    borderRadius: theme.radius.sm,
  },
  historyRow: {
    paddingVertical: theme.space(3),
    paddingHorizontal: theme.space(1),
  },
});
