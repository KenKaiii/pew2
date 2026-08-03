/**
 * What the finished turn cost, in one quiet line under the answer.
 *
 * The live activity line exits when the turn ends, which would otherwise leave
 * no trace of work that took minutes. This is that trace: a receipt, not a
 * status. Faint, static, and it never competes with the reply above it.
 *
 * Everything in it is measured or reported — the duration by this device, the
 * tool count by the agent, tokens only when the agent volunteered a figure.
 * It is replaced by the activity line again the moment the next prompt is sent.
 */
import { memo, useEffect, useRef } from "react";
import { Animated, StyleSheet, Text } from "react-native";
import { theme } from "../theme";
import { receiptText, type TurnReceipt as Receipt } from "../activity";
import { useReducedMotion } from "./useReducedMotion";

/** Slower than a control's transition: this arrives, it does not respond. */
const FADE_DURATION = 260;

function TurnReceiptView({ receipt }: { receipt: Receipt }) {
  const reduceMotion = useReducedMotion();
  const fade = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reduceMotion) {
      fade.setValue(1);
      return;
    }
    fade.setValue(0);
    Animated.timing(fade, {
      toValue: 1,
      duration: FADE_DURATION,
      easing: theme.easing,
      useNativeDriver: true,
    }).start();
  }, [fade, reduceMotion, receipt]);

  const text = receiptText(receipt);

  return (
    <Animated.View style={[styles.row, { opacity: fade }]} accessible accessibilityLabel={text}>
      {/* The mark that says this row is the app talking, not the agent. */}
      <Text style={styles.mark}>✻</Text>
      <Text style={styles.text} numberOfLines={1}>
        {text}
      </Text>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Same left rail and rhythm as the activity line it replaces.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1.5),
    height: theme.line.body,
    marginTop: theme.space(5),
    paddingHorizontal: theme.gutter,
  },
  mark: {
    fontSize: theme.font.small,
    lineHeight: theme.line.body,
    color: theme.color.accent,
  },
  text: {
    flexShrink: 1,
    fontSize: theme.font.small,
    lineHeight: theme.line.body,
    color: theme.color.textFaint,
  },
});

export const TurnReceipt = memo(TurnReceiptView);
