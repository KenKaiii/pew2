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
import { forwardRef, memo, useEffect, useImperativeHandle, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Pressable,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import Reanimated, {
  Easing as ReanimatedEasing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { composerHeight, type ComposerBounds } from "./composerHeight";
import { touchSlop } from "./controls";
import { haptics } from "./haptics";
import { Glass } from "./Glass";
import { useReducedMotion } from "./useReducedMotion";
import { CommandToken } from "./CommandToken";
import { splitCommand } from "../slashCommands";
import { AttachmentChips } from "./AttachmentChips";
import type { PendingAttachment } from "../attachments";
import type { Dictation } from "./useDictation";

/** Stable identity, so the default never re-renders a memoized child. */
const EMPTY_ATTACHMENTS: readonly PendingAttachment[] = [];

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
 * Everything in the control that is not text.
 *
 * The text region spans from the top down to `COLLAPSED - space(2)`, and is
 * inset by `space(3)` at the top, so the chrome around it is the action row
 * less that overlap plus the inset.
 *
 * Resolved to a plain number here rather than left as `theme.space` calls
 * because the height worklet below closes over it, and `theme.space` is a
 * function — a worklet cannot reach back into JS to call it.
 */
const CHROME = COLLAPSED - theme.space(2) + theme.space(3);

/** Total control height that shows `lines` of text above the action row. */
const heightForLines = (lines: number) => lines * theme.line.body + CHROME;

/** Floor: one line of text above the action row. */
const MIN_HEIGHT = heightForLines(1);
const MAX_HEIGHT = heightForLines(MAX_LINES);
/** Text height at which the box stops growing and the input starts scrolling. */
const MAX_TEXT_HEIGHT = MAX_LINES * theme.line.body;

/**
 * The theme's metrics, resolved once for the height worklet below.
 *
 * Sampled here rather than read inside the worklet because `theme.space` is a
 * function and a worklet cannot reach back into JS to call one. See
 * `composerHeight.ts` for the arithmetic itself, which lives there so it can be
 * tested without importing this file — the runner cannot parse `react-native`.
 */
const BOUNDS: ComposerBounds = {
  collapsed: COLLAPSED,
  chrome: CHROME,
  min: MIN_HEIGHT,
  max: MAX_HEIGHT,
};

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

/** Imperative surface: the command sheet hands focus back after a pick. */
export interface ComposerHandle {
  focus(): void;
}

interface ComposerProps {
  value: string;
  onChangeText: (text: string) => void;
  onSend: () => void;
  /** Shows a stop control instead of send while the agent is working. */
  busy?: boolean;
  onStop?: () => void;
  placeholder?: string;
  editable?: boolean;
  /** Files staged for this message. Empty is the common case. */
  attachments?: readonly PendingAttachment[];
  /** Opens the source sheet. Absent leaves the `+` inert, as it was. */
  onAttach?: () => void;
  onRemoveAttachment?: (id: string) => void;
  /** Dictation state from `useDictation`. Absent hides the mic. */
  dictation?: Dictation;
}

function ComposerView({
  value,
  onChangeText,
  onSend,
  busy = false,
  onStop,
  placeholder = "Ask me. Task me...",
  editable = true,
  attachments = EMPTY_ATTACHMENTS,
  onAttach,
  onRemoveAttachment,
  dictation,
}: ComposerProps, ref: React.Ref<ComposerHandle>) {
  const hasText = value.trim().length > 0;
  // A photo with no words is a real message — "look at this" is implied by the
  // act of attaching it — so attachments arm send on their own.
  const canSend = hasText || attachments.length > 0;
  const input = useRef<TextInput>(null);
  useImperativeHandle(ref, () => ({ focus: () => input.current?.focus() }), []);

  // The leading `/command`, which is drawn differently from the rest of the
  // draft. Undefined for ordinary prose, which is the common case.
  const split = splitCommand(value);

  const [focused, setFocused] = useState(false);
  // Whether the draft has reached the ceiling and the field scrolls internally.
  //
  // A boolean rather than the measured height it is derived from, because this
  // is state: every distinct value re-renders the composer, and holding the
  // height here meant a full React commit for every line the draft grew by — on
  // the same JS thread the measurement has to cross to reach the UI thread.
  // Flipping once, at the eighth line, is the whole of what the prop needs.
  const [atCeiling, setAtCeiling] = useState(false);
  const reduceMotion = useReducedMotion();

  // Focus alone: the keyboard's visibility is a separate event stream with no
  // fixed ordering against it, and mixing the two left the placeholder resting
  // in its expanded position after an unfocus.
  const expanded = focused || hasText || busy || attachments.length > 0;

  // Grow with the text, then scroll internally rather than eat the thread.
  //
  // A shared value and never React state. The measurement arrives on the JS
  // thread either way — it is a native event — but what follows it is not the
  // same amount of work. State meant a re-render, reconciliation of the whole
  // composer, a fresh `useAnimatedStyle` closure and a commit before the box
  // could move; a shared value is one write that Reanimated syncs to the UI
  // runtime with no render at all. Per wrapped line, that difference showed as
  // the box — and the caret riding inside it — lagging behind the text on every
  // return and every auto-wrap.
  //
  // The first attempt at this kept a `contentHeight` state beside it for
  // `scrollEnabled`, which put the same render back on the same path: every
  // measurement was a distinct number, so every wrapped line still re-rendered
  // the whole composer while the UI thread was mid-animation. `atCeiling`
  // above is the same information reduced to what the prop actually needs, and
  // it changes twice in a draft's life instead of once per line.
  //
  // Only meaningful once expanded: a multiline TextInput reports the natural
  // height of its own placeholder even while collapsed, wrapped into the narrow
  // inline slot between the two buttons, which would inflate this box before
  // the user has typed anything. So the measurement is taken only while
  // expanded, and collapsing puts it back to one line.
  const textHeight = useSharedValue<number>(theme.line.body);

  const sendIn = useRef(new Animated.Value(0)).current;
  // While listening, the mic *is* the control the user needs back, so send does
  // not slide over it even once words have landed in the draft.
  const sendTarget = (canSend || busy) && !dictation?.listening ? 1 : 0;
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

  // Grow and shrink the surface on one fixed curve. Nothing here borrows the
  // keyboard's timing: the dock this control sits in is already carried by the
  // keyboard's own transaction, so a second animation would only fight it.
  //
  // This replaced a `LayoutAnimation.configureNext` call. That API is global —
  // it applies to the next layout pass of the *whole tree*, not to the view
  // that asked for it — so focusing the input also swept the context row's
  // unmount and the transcript's inset change onto this curve, in the middle of
  // the keyboard's own transition. Three differently-timed animations across
  // the same frames is what the first tap felt like. Scoped here, the box is
  // the only thing that moves, and it moves on the UI thread.
  //
  // What eases is *how open the box is*, never the height itself. The box also
  // grows as the draft wraps onto another line, and easing that would leave it
  // trailing 140ms behind the text being typed into it. `composerHeight` reads
  // both values on the UI thread each frame, so the transition eases while a
  // wrap lands whole, including partway through an open that is still running.
  // The old imperative call got that for free by being fired from the focus
  // handler and nowhere else.
  const openness = useSharedValue(expanded ? 1 : 0);

  useEffect(() => {
    // Discarding the measurement here rather than at the next render keeps it
    // in step with the curve that is about to run: both leave in one effect.
    if (!expanded) textHeight.value = theme.line.body;
    openness.value = withTiming(expanded ? 1 : 0, {
      duration: reduceMotion ? 0 : EXPAND_DURATION,
      easing: ReanimatedEasing.out(ReanimatedEasing.cubic),
    });
  }, [expanded, reduceMotion, openness, textHeight]);

  const surface = useAnimatedStyle(() => ({
    height: composerHeight(BOUNDS, openness.value, textHeight.value),
  }));

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
    <View style={styles.stack}>
      {/* Above the pill rather than inside it: the pill's contents are
          absolutely positioned against a height computed from the draft, and
          threading a variable-height row through that math is what would make
          the text jump. */}
      {attachments.length > 0 && (
        <AttachmentChips attachments={attachments} onRemove={onRemoveAttachment} />
      )}

      <Glass radius={theme.radius.composer} tier="raised">
        <Reanimated.View style={surface}>
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
              ref={input}
              style={styles.input}
              // The command is not text here — it is the badge in the action row
              // below — so the field holds only the instructions after it, and
              // every edit is put back together before it leaves this component.
              value={split ? split.rest.replace(/^ /, "") : value}
              onChangeText={(text) =>
                onChangeText(split ? `${split.command} ${text}` : text)
              }
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onContentSizeChange={(event) => {
                const measured = event.nativeEvent.contentSize.height;
                if (expanded) textHeight.value = measured;
                // Only when the answer changes. `scrollEnabled` is a JS-side
                // prop and needs a render, but it needs one twice in a draft's
                // life — not once per wrapped line.
                const capped = measured >= MAX_TEXT_HEIGHT;
                if (capped !== atCeiling) setAtCeiling(capped);
              }}
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
              scrollEnabled={atCeiling}
            />
          </Animated.View>

          {/* Always the bottom 58pt: the entire pill when collapsed, the action
              row once expanded. Anchoring it means the buttons never shift. */}
          <View style={styles.actions}>
            {/* Grouped, because the row is `space-between`: a third loose child
                would scatter the three across the width instead of keeping the
                badge next to the button it belongs beside. */}
            <View style={styles.leading}>
              <Pressable
                style={({ pressed }) => [
                  styles.actionButton,
                  !onAttach && styles.notImplemented,
                  pressed && styles.actionPressed,
                ]}
                hitSlop={touchSlop(theme.space(1))}
                accessibilityRole="button"
                accessibilityLabel={onAttach ? "Add attachment" : "Add attachment, not available yet"}
                accessibilityState={{ disabled: !onAttach }}
                disabled={!onAttach}
                onPress={() => {
                  haptics.tap();
                  onAttach?.();
                }}
              >
                <Ionicons name="add" size={22} color={theme.color.glyph} />
              </Pressable>

              {/* Beside the attachment button and the same height as it, so the
                  command reads as another control on that row rather than as text
                  that escaped the field. Removing it is a tap on the badge itself:
                  a separate 'x' inside the input sat exactly where the caret goes. */}
              {split && (
                <Pressable
                  style={({ pressed }) => [styles.badge, pressed && styles.badgePressed]}
                  hitSlop={touchSlop(theme.space(1))}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove ${split.command}`}
                  onPress={() => {
                    // Keeps whatever was typed since: a mis-picked command should
                    // not also discard the instructions written under it.
                    onChangeText(split.rest.replace(/^ /, ""));
                    input.current?.focus();
                  }}
                >
                  <CommandToken text={split.command} size={theme.font.small} lineHeight={18} />
                  <Ionicons name="close" size={13} color={theme.color.accent} />
                </Pressable>
              )}
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
                <Pressable
                  style={({ pressed }) => [
                    styles.actionButton,
                    !dictation?.available && styles.notImplemented,
                    dictation?.listening && styles.listening,
                    pressed && styles.actionPressed,
                  ]}
                  hitSlop={touchSlop(theme.space(1))}
                  accessibilityRole="button"
                  accessibilityLabel={
                    !dictation?.available
                      ? "Voice input, not available on this device"
                      : dictation.listening
                        ? "Stop dictating"
                        : "Dictate a message"
                  }
                  accessibilityState={{
                    disabled: !dictation?.available,
                    selected: dictation?.listening ?? false,
                  }}
                  disabled={!dictation?.available}
                  onPress={() => dictation?.toggle()}
                >
                  {/* Filled while listening: the difference has to be legible at a
                      glance on a control the size of a fingertip, so it is colour
                      *and* weight rather than colour alone. */}
                  <Ionicons
                    name={dictation?.listening ? "mic" : "mic-outline"}
                    size={20}
                    color={dictation?.listening ? theme.color.accent : theme.color.glyph}
                  />
                </Pressable>
              </Animated.View>

              <Animated.View
                pointerEvents={sendTarget === 1 ? "auto" : "none"}
                style={[styles.trailingLayer, { opacity: sendIn }]}
              >
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={busy ? "Stop generating" : "Send message"}
                  accessibilityState={{ disabled: !busy && !canSend }}
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
                  disabled={!busy && !canSend}
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
        </Reanimated.View>
      </Glass>
    </View>
  );
}

const styles = StyleSheet.create({
  stack: { gap: theme.space(2) },
  inputWrap: { position: "absolute", top: 0 },
  leading: { flexDirection: "row", alignItems: "center", flexShrink: 1 },
  // Same height and radius as the attachment button beside it, so the row reads
  // as one set of controls. Sized by its content, since a command name's length
  // is the agent's business, not ours.
  badge: {
    height: BUTTON,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1),
    paddingHorizontal: theme.space(2),
    marginLeft: theme.space(1),
    borderRadius: BUTTON / 2,
    backgroundColor: theme.glass.control.fill,
  },
  badgePressed: { opacity: 0.6 },
  // Small and solid: a deliberate target, but never competing with the word it
  // belongs to. Vertically centred on the line rather than the whole box.
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
  actionPressed: { opacity: 0.6 },
  listening: { backgroundColor: theme.color.accentSoft },
  sendButton: { backgroundColor: theme.color.text },
  sendPressed: { backgroundColor: theme.color.textDim },
  notImplemented: { opacity: 0.4 },
});

// Memoized: a streamed chunk re-renders the screen many times a second, and
// none of those chunks change anything here.
export const Composer = memo(forwardRef<ComposerHandle, ComposerProps>(ComposerView));
