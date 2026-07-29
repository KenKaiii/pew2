/**
 * Placeholders shown while content is on its way.
 *
 * A resumed conversation takes a couple of seconds to stream back from the
 * agent, and the drawer's history arrives provider by provider. Without these,
 * both read as "empty" for exactly long enough to feel broken — the worst
 * possible lie a loading state can tell.
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

/**
 * The conversation pane while a session is being resumed: blocks shaped like
 * the alternating user/agent messages that are about to land.
 */
export function ThreadSkeleton() {
  return (
    <View style={styles.thread} accessibilityLabel="Loading conversation">
      <Skeleton style={[styles.bubble, styles.agentBubble, { width: "72%", height: 88 }]} />
      <Skeleton style={[styles.bubble, styles.userBubble, { width: "46%", height: 40 }]} />
      <Skeleton style={[styles.bubble, styles.agentBubble, { width: "84%", height: 132 }]} />
      <Skeleton style={[styles.bubble, styles.agentBubble, { width: "58%", height: 60 }]} />
      <Skeleton style={[styles.bubble, styles.userBubble, { width: "38%", height: 40 }]} />
    </View>
  );
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
  thread: {
    flex: 1,
    paddingHorizontal: theme.gutter,
    paddingTop: theme.space(6),
    gap: theme.space(4),
  },
  bubble: { borderRadius: theme.radius.lg },
  agentBubble: { alignSelf: "flex-start" },
  userBubble: { alignSelf: "flex-end" },
  historyRow: {
    paddingVertical: theme.space(3),
    paddingHorizontal: theme.space(1),
  },
});
