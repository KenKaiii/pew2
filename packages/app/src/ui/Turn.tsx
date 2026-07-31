/**
 * One rendered turn in the thread.
 *
 * Neither side shows avatars. User prompts sit in one quiet raised surface that
 * hugs their content; agent output uses the full reading rail like a document.
 * CommonMark is rendered with native components, including headings, emphasis,
 * lists, links, tables, images, line breaks, and contained code blocks.
 * Each new turn fades in once while streamed chunks update the same turn.
 */
import { useEffect, useRef } from "react";
import { Animated, StyleSheet, View } from "react-native";
import { theme } from "../theme";
import { useReducedMotion } from "./useReducedMotion";
import { MarkdownText } from "./MarkdownText";
import {
  adaptiveUserBubbleStyle,
  blockUserBubbleStyle,
  userPromptNeedsFullWidth,
} from "./messageLayoutStyles";
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

  if (!turn.text.trim()) return null;
  // Preserve leading indentation: CommonMark uses it for indented code blocks.
  const text = turn.text.trimEnd();

  if (turn.role === "user") {
    return (
      <Animated.View style={[styles.userRow, { opacity: appear }]}>
        <View
          style={[styles.userBubble, userPromptNeedsFullWidth(text) && blockUserBubbleStyle]}
        >
          <MarkdownText text={text} />
        </View>
      </Animated.View>
    );
  }

  if (turn.role === "system") {
    return (
      <Animated.View style={[styles.systemRow, { opacity: appear }]}>
        <MarkdownText text={text} tone="system" />
      </Animated.View>
    );
  }

  if (turn.role === "thought") {
    return (
      <Animated.View style={[styles.thoughtRow, { opacity: appear }]}>
        <MarkdownText text={text} tone="thought" />
      </Animated.View>
    );
  }

  return (
    <Animated.View style={[styles.agentRow, { opacity: appear }]}>
      <MarkdownText text={text} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  userRow: { width: "100%", minWidth: 0, alignItems: "flex-end" },
  userBubble: {
    ...adaptiveUserBubbleStyle,
    backgroundColor: theme.color.surfaceRaised,
    borderRadius: theme.radius.lg,
    paddingHorizontal: theme.space(3.5),
    paddingVertical: theme.space(2.75),
  },
  agentRow: { width: "100%" },
  thoughtRow: { width: "100%", paddingHorizontal: theme.space(1) },
  systemRow: { width: "100%" },
});
