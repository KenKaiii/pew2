/**
 * Message composer, with two states and a continuous transition between them.
 *
 * Resting: a single 58pt pill — attach, text, voice — all on one line, so an
 * idle screen shows one calm control rather than a tall empty box.
 *
 * Focused (or once text is entered): the text region lifts to its own full-width
 * row above the action row. This is what stops a long draft from ever clipping
 * or overlapping the attach and send buttons in the lower corners.
 *
 * The two states are one layout, not two trees. The action row is always
 * anchored to the bottom 58pt — which *is* the whole pill when collapsed — so
 * the buttons never move, and only the text region animates. That also keeps the
 * TextInput mounted throughout, so focus is never dropped mid-transition.
 *
 * Metrics and colours are sampled from the reference build: 36pt buttons inset
 * 11pt from the pill edge, #e0e0e0 glyphs, #828282 placeholder.
 */
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  LayoutAnimation,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { touchSlop } from "./controls";
import { haptics } from "./haptics";
import { Glass } from "./Glass";
import { useReducedMotion } from "./useReducedMotion";

const COLLAPSED = theme.size.composerCollapsed;
const INSET = theme.size.composerInset;
const BUTTON = theme.size.composerButton;
/** Clearance the inline text needs to avoid the two buttons. */
const INLINE_SIDE = INSET + BUTTON + theme.space(2);
/** One fixed curve for expand/collapse, independent of the keyboard's own. */
const EXPAND_DURATION = 140;
/** How far the text sits below its expanded position while the pill is closed. */
const TEXT_DROP = (COLLAPSED - theme.line.body) / 2 - theme.space(3);

/**
 * Lines the box can grow to before the text scrolls internally.
 *
 * It follows the draft one line at a time from a single line up; this is only
 * the ceiling. Composing a prompt for a coding agent is closer to writing than
 * to chat, so at least three lines must be visible at once before any scroll.
 */
const MAX_LINES = 8;

/**
 * Total control height that shows `lines` of text above the action row.
 *
 * The text region spans from the top down to `COLLAPSED - space(2)`, and is
 * inset by `space(3)` at the top, so the chrome around the text is the action
 * row less that overlap plus the inset.
 */
const heightForLines = (lines: number) =>
  lines * theme.line.body + COLLAPSED - theme.space(2) + theme.space(3);

/** Floor: one line of text above the action row. */
const MIN_HEIGHT = heightForLines(1);
const MAX_HEIGHT = heightForLines(MAX_LINES);
/** Text height at which the box stops growing and the input starts scrolling. */
const MAX_TEXT_HEIGHT = MAX_LINES * theme.line.body;

/**
 * iOS adds the whole leading (lineHeight minus the font's own height) above the
 * glyphs in a multiline TextInput instead of splitting it top and bottom. A line
 * box centred by pure geometry therefore renders about half a leading too low —
 * measured at 2pt here, which is subtle but visible against the round buttons
 * beside it. Subtract that half back so the text is optically centred.
 *
 * 1.2em is the system font's ascent + descent.
 */
const HALF_LEADING = Math.max(0, (theme.line.body - theme.font.body * 1.2) / 2);

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
  const [focused, setFocused] = useState(false);
  const [contentHeight, setContentHeight] = useState<number>(theme.line.body);
  const reduceMotion = useReducedMotion();

  // Focus alone: the keyboard's visibility is a separate event stream with no
  // fixed ordering against it, and mixing the two left the placeholder resting
  // in its expanded position after an unfocus.
  const expanded = focused || hasText || busy;

  // Grow with the text, then scroll internally rather than eat the thread.
  // `contentHeight` is only meaningful once expanded: a multiline TextInput
  // reports its natural height even while collapsed, which would otherwise
  // inflate this box before the user has typed anything.
  const textHeight = expanded ? contentHeight : theme.line.body;
  const expandedHeight = Math.min(
    MAX_HEIGHT,
    // One line while the draft is one line: the box tracks the text rather than
    // opening pre-grown into space nothing occupies yet.
    Math.max(MIN_HEIGHT, textHeight + COLLAPSED - theme.space(2) + theme.space(3)),
  );

  const sendIn = useRef(new Animated.Value(0)).current;
  const sendTarget = hasText || busy ? 1 : 0;
  // The text rides its own native transform rather than the surrounding layout,
  // so its duration is fixed no matter what else is animating in the same commit.
  const textDrop = useRef(new Animated.Value(expanded ? 0 : TEXT_DROP)).current;

  useEffect(() => {
    const animation = Animated.timing(textDrop, {
      toValue: expanded ? 0 : TEXT_DROP,
      duration: reduceMotion ? 0 : EXPAND_DURATION,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [expanded, reduceMotion, textDrop]);

  const setFocus = (next: boolean) => {
    // Grow and shrink the surface on one fixed curve. Nothing here borrows the
    // keyboard's timing: the dock this control sits in is already carried by the
    // keyboard's own transaction, so a second animation would only fight it.
    if (!reduceMotion) {
      LayoutAnimation.configureNext({
        duration: EXPAND_DURATION,
        update: { duration: EXPAND_DURATION, type: "easeOut" },
      });
    }
    setFocused(next);
  };

  useEffect(() => {
    const animation = Animated.timing(sendIn, {
      toValue: sendTarget,
      duration: reduceMotion ? 0 : theme.motion.fast,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [sendTarget, reduceMotion, sendIn]);

  return (
    <Glass radius={theme.radius.composer} tier="raised">
      <View style={{ height: expanded ? expandedHeight : COLLAPSED }}>
        <Animated.View
          style={[
            styles.inputWrap,
            {
              left: expanded ? INSET + theme.space(1) : INLINE_SIDE,
              right: expanded ? INSET + theme.space(1) : INLINE_SIDE,
              bottom: expanded ? COLLAPSED - theme.space(2) : 0,
              // Fixed: the drop below is what moves the text between states.
              top: theme.space(3) - HALF_LEADING,
              transform: [{ translateY: textDrop }],
            },
          ]}
        >
          <TextInput
            style={styles.input}
            value={value}
            onChangeText={onChangeText}
            onFocus={() => setFocus(true)}
            onBlur={() => setFocus(false)}
            onContentSizeChange={(event) =>
              setContentHeight(event.nativeEvent.contentSize.height)
            }
            placeholder={placeholder}
            placeholderTextColor={theme.color.placeholder}
            multiline
            editable={editable}
            accessibilityLabel="Message"
            submitBehavior="newline"
            // A scrollable TextInput reports its *visible* height as content
            // size, so while scrolling is on it always measures one line and the
            // box can never grow. Scrolling therefore stays off until the box
            // has actually reached its ceiling.
            scrollEnabled={contentHeight >= MAX_TEXT_HEIGHT}
          />
        </Animated.View>

        {/* Always the bottom 58pt: the entire pill when collapsed, the action
            row once expanded. Anchoring it means the buttons never shift. */}
        <View style={styles.actions}>
          <View
            style={[styles.actionButton, styles.notImplemented]}
            accessibilityRole="button"
            accessibilityLabel="Add attachment, not available yet"
            accessibilityState={{ disabled: true }}
          >
            <Ionicons name="add" size={22} color={theme.color.glyph} />
          </View>

          <View style={styles.trailing}>
            <Animated.View
              pointerEvents={sendTarget === 1 ? "none" : "auto"}
              style={[
                styles.trailingLayer,
                {
                  opacity: sendIn.interpolate({
                    inputRange: [0, 1],
                    outputRange: [1, 0],
                  }),
                },
              ]}
            >
              <View
                style={[styles.actionButton, styles.notImplemented]}
                accessibilityRole="button"
                accessibilityLabel="Voice input, not available yet"
                accessibilityState={{ disabled: true }}
              >
                <Ionicons name="mic-outline" size={20} color={theme.color.glyph} />
              </View>
            </Animated.View>

            <Animated.View
              pointerEvents={sendTarget === 1 ? "auto" : "none"}
              style={[styles.trailingLayer, { opacity: sendIn }]}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={busy ? "Stop generating" : "Send message"}
                accessibilityState={{ disabled: !busy && !hasText }}
                hitSlop={touchSlop(BUTTON)}
                // Sending commits work to another machine, so it lands heavier
                // than a navigation tap; stopping is a correction, not a commit.
                onPress={() => {
                  if (busy) {
                    haptics.warned();
                    onStop?.();
                    return;
                  }
                  haptics.sent();
                  onSend();
                }}
                disabled={!busy && !hasText}
                style={({ pressed }) => [
                  styles.actionButton,
                  styles.sendButton,
                  pressed && styles.sendPressed,
                ]}
              >
                <Ionicons
                  name={busy ? "square" : "arrow-up"}
                  size={busy ? 13 : 20}
                  color="#0f0f0f"
                />
              </Pressable>
            </Animated.View>
          </View>
        </View>
      </View>
    </Glass>
  );
}

const styles = StyleSheet.create({
  inputWrap: { position: "absolute", top: 0 },
  input: {
    color: theme.color.text,
    fontSize: theme.font.body,
    lineHeight: theme.line.body,
    // Zero the platform's own padding so the animated values above are the
    // only thing positioning the text.
    padding: 0,
    textAlignVertical: "top",
  },
  actions: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    height: COLLAPSED,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: INSET,
  },
  actionButton: {
    width: BUTTON,
    height: BUTTON,
    borderRadius: BUTTON / 2,
    alignItems: "center",
    justifyContent: "center",
    // Nested inside the composer's own glass, so it takes the fill only. A
    // second rim this close in would read as a seam rather than a highlight.
    backgroundColor: theme.glass.control.fill,
  },
  trailing: { width: BUTTON, height: BUTTON },
  trailingLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  sendButton: { backgroundColor: theme.color.text },
  sendPressed: { backgroundColor: theme.color.textDim },
  notImplemented: { opacity: 0.4 },
});
