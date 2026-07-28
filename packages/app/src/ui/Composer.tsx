/**
 * The composer pill.
 *
 * Sits directly beneath the thread with one consistent gap, and keeps that same
 * gap when the keyboard is open, so the last message is never hidden behind the
 * input. Height grows with the text up to a cap, then scrolls internally.
 */
import { useEffect, useRef } from "react";
import { Animated, Pressable, StyleSheet, TextInput, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { touchSlop } from "./controls";
import { Glass } from "./Glass";
import { useReducedMotion } from "./useReducedMotion";

interface ComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  /** Shows a stop control instead of send while the agent is working. */
  busy?: boolean;
  onStop?: () => void;
  placeholder?: string;
  editable?: boolean;
}

export function Composer({
  value,
  onChangeText,
  onSend,
  busy = false,
  onStop,
  placeholder = "Ask me. Task me...",
  editable = true,
}: ComposerProps) {
  const hasText = value.trim().length > 0;
  const reduceMotion = useReducedMotion();
  // Cross-fades the trailing control between voice and send. A fade reads as
  // one control changing meaning; a slide would read as two controls swapping.
  const sendIn = useRef(new Animated.Value(0)).current;
  const target = hasText || busy ? 1 : 0;

  // In an effect, not during render: starting an animation is a side effect.
  useEffect(() => {
    const animation = Animated.timing(sendIn, {
      toValue: target,
      duration: reduceMotion ? 0 : theme.motion.fast,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [target, reduceMotion, sendIn]);

  return (
    <Glass radius={theme.radius.pill} style={styles.row} intensity={50}>
      {/* Attachments are not implemented yet. Shown disabled rather than wired
          to a no-op, so the control never lies about what it does. */}
      <View
        style={[styles.leading, styles.notImplemented]}
        accessibilityRole="button"
        accessibilityLabel="Add attachment, not available yet"
        accessibilityState={{ disabled: true }}
      >
        <Ionicons name="add" size={22} color={theme.color.text} />
      </View>

      <TextInput
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={theme.color.textFaint}
        multiline
        editable={editable}
        accessibilityLabel="Message"
        submitBehavior="newline"
      />

      <View style={styles.trailing}>
        <Animated.View
          pointerEvents={target === 1 ? "none" : "auto"}
          style={[styles.trailingLayer, { opacity: sendIn.interpolate({
            inputRange: [0, 1],
            outputRange: [1, 0],
          }) }]}
        >
          {/* Same as the attachment button: visible, honest, not yet wired. */}
          <View
            style={[styles.trailingButton, styles.notImplemented]}
            accessibilityRole="button"
            accessibilityLabel="Voice input, not available yet"
            accessibilityState={{ disabled: true }}
          >
            <Ionicons name="mic-outline" size={19} color={theme.color.text} />
          </View>
        </Animated.View>

        <Animated.View
          pointerEvents={target === 1 ? "auto" : "none"}
          style={[styles.trailingLayer, { opacity: sendIn }]}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={busy ? "Stop generating" : "Send message"}
            hitSlop={touchSlop(theme.size.composerButton)}
            onPress={busy ? onStop : onSend}
            style={({ pressed }) => [
              styles.trailingButton,
              styles.sendButton,
              pressed && styles.sendPressed,
            ]}
          >
            <Ionicons
              name={busy ? "square" : "arrow-up"}
              size={busy ? 13 : 20}
              color="#000"
            />
          </Pressable>
        </Animated.View>
      </View>
    </Glass>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    // flex-end so the buttons stay pinned to the last line as the input grows.
    // With the input's minHeight matching the buttons, a single line is centred.
    alignItems: "flex-end",
    gap: theme.space(2),
    paddingVertical: theme.space(1.5),
    paddingHorizontal: theme.space(1.5),
  },
  leading: {
    width: theme.size.composerButton,
    height: theme.size.composerButton,
    borderRadius: theme.size.composerButton / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  input: {
    flex: 1,
    color: theme.color.text,
    fontSize: theme.font.body,
    lineHeight: theme.line.body,
    // Match the button height and split the leftover space evenly, so the
    // first line of text sits on the same centre line as the + and send
    // buttons. Asymmetric padding here is what makes a composer look "off".
    minHeight: theme.size.composerButton,
    paddingTop: (theme.size.composerButton - theme.line.body) / 2,
    paddingBottom: (theme.size.composerButton - theme.line.body) / 2,
    maxHeight: 132,
    paddingHorizontal: theme.space(1),
    // Android ignores padding-based centring on multiline inputs.
    textAlignVertical: "center",
  },
  trailing: {
    width: theme.size.composerButton,
    height: theme.size.composerButton,
  },
  trailingLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  trailingButton: {
    width: theme.size.composerButton,
    height: theme.size.composerButton,
    borderRadius: theme.size.composerButton / 2,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "rgba(255,255,255,0.10)",
  },
  sendButton: { backgroundColor: theme.color.text },
  sendPressed: { backgroundColor: theme.color.textDim },
  pressed: { backgroundColor: "rgba(255,255,255,0.20)" },
  notImplemented: { opacity: 0.4 },
});
