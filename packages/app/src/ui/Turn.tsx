/**
 * One rendered turn in the thread.
 *
 * Neither side shows avatars. User prompts sit in one quiet raised surface that
 * hugs its own text and aligns right, capped at 85% of the rail so a long prompt
 * still wraps; agent output uses the full reading rail as plain text so long
 * responses read like a document. Each new turn fades in once. Streamed chunks append to
 * the same Text node, avoiding a fake typewriter delay or per-token layout churn.
 */
import { useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { useReducedMotion } from "./useReducedMotion";
import type { Turn as TurnModel } from "../useDaemon";

export function Turn({ turn }: { turn: TurnModel }) {
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
      <Text style={styles.agentText}>{text}</Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  userRow: { width: "100%", alignItems: "flex-end" },
  userBubble: {
    maxWidth: "85%",
    backgroundColor: theme.color.surfaceRaised,
    borderRadius: theme.radius.lg,
    paddingHorizontal: theme.space(3.5),
    paddingVertical: theme.space(2.75),
  },
  userText: {
    color: theme.color.text,
    fontSize: theme.font.body,
    lineHeight: theme.line.body,
  },
  agentRow: { width: "100%" },
  agentText: {
    width: "100%",
    color: theme.color.text,
    fontSize: theme.font.body,
    lineHeight: theme.line.body,
  },
  thoughtText: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    lineHeight: 20,
    paddingHorizontal: theme.space(1),
  },
  systemText: {
    color: theme.color.danger,
    fontSize: theme.font.small,
    lineHeight: 20,
  },
});
