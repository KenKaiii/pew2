/**
 * One rendered turn in the thread.
 *
 * User messages sit in a raised bubble on the right; agent output is plain text
 * on the canvas so long responses read like a document rather than a stack of
 * boxes. Each turn fades in once, which is enough to signal arrival without
 * moving text the user may already be reading.
 */
import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { Orb } from "./Orb";
import { useReducedMotion } from "./useReducedMotion";
import type { Turn as TurnModel } from "../useDaemon";

export function Turn({ turn, color }: { turn: TurnModel; color?: string }) {
  const appear = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const animation = Animated.timing(appear, {
      toValue: 1,
      duration: reduceMotion ? 0 : theme.motion.base,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [appear, reduceMotion]);

  const text = turn.text.trim();
  if (!text) return null;

  if (turn.role === "user") {
    return (
      <Animated.View style={[styles.userRow, { opacity: appear }]}>
        <View style={styles.userBubble}>
          <Text style={styles.userText}>{text}</Text>
        </View>
      </Animated.View>
    );
  }

  if (turn.role === "system") {
    return (
      <Animated.View style={{ opacity: appear }}>
        <Text style={styles.systemText}>{text}</Text>
      </Animated.View>
    );
  }

  if (turn.role === "thought") {
    return (
      <Animated.View style={{ opacity: appear }}>
        <Text style={styles.thoughtText}>{text}</Text>
      </Animated.View>
    );
  }

  return (
    <Animated.View style={[styles.agentRow, { opacity: appear }]}>
      <View style={styles.agentOrb}>
        <Orb color={color} size={22} />
      </View>
      <Text style={styles.agentText}>{text}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  userRow: { alignItems: "flex-end" },
  userBubble: {
    maxWidth: "84%",
    backgroundColor: theme.color.surfaceRaised,
    borderRadius: theme.radius.lg,
    paddingHorizontal: theme.space(3.5),
    paddingVertical: theme.space(2.5),
  },
  userText: {
    color: theme.color.text,
    fontSize: theme.font.body,
    lineHeight: theme.line.body,
  },
  agentRow: { flexDirection: "row", gap: theme.space(2.5) },
  // Centre the 22pt orb on the first 22pt line of text rather than letting it
  // hang from the top edge.
  agentOrb: { paddingTop: (theme.line.body - 22) / 2 },
  agentText: {
    flex: 1,
    color: theme.color.text,
    fontSize: theme.font.body,
    lineHeight: theme.line.body,
  },
  thoughtText: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    lineHeight: 20,
    paddingLeft: theme.space(8),
  },
  systemText: {
    color: theme.color.danger,
    fontSize: theme.font.small,
    lineHeight: 20,
  },
});
