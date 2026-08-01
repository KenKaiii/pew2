/**
 * The conversation transcript.
 *
 * A recycling list rather than a ScrollView, because the whole fold lives in
 * memory and re-parsing every markdown turn on each streamed chunk is what made
 * opening a session feel like a re-render.
 *
 * Scroll position is native business here, not ours. `maintainVisibleContentPosition`
 * is on by default in FlashList v2, so a row that grows mid-stream no longer
 * pushes the rows above it, and `startRenderingFromBottom` means the very first
 * painted frame is already at the newest message — no reveal, no catch-up scroll.
 */
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
} from "react";
import {
  Animated,
  Platform,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import { FlashList, type FlashListRef, type ListRenderItemInfo } from "@shopify/flash-list";
import { theme } from "../theme";
import { Turn } from "./Turn";
import { useReducedMotion } from "./useReducedMotion";
import type { Turn as TurnData } from "../useDaemon";

export type ChatThreadRef = FlashListRef<TurnData>;

type Props = {
  turns: TurnData[];
  /** Clearance under the floating nav, before the first message. */
  threadTop: number;
  /** Clearance above the composer dock, after the last message. */
  threadBottom: number;
  /** The agent is mid-turn: show the streaming indicator below the transcript. */
  working: boolean;
  /** Insets so the scroll indicator stays inside the unobscured reading area. */
  indicatorTop: number;
  indicatorBottom: number;
  onAtBottomChange: (atBottom: boolean) => void;
};

function ChatThreadView(
  {
    turns,
    threadTop,
    threadBottom,
    working,
    indicatorTop,
    indicatorBottom,
    onAtBottomChange,
  }: Props,
  ref: React.Ref<ChatThreadRef>,
) {
  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<TurnData>) => {
      // An agent turn is committed empty and filled by later chunks. Rendering
      // its cell would reserve the gap below the reply before there is anything
      // in it, which the reader sees as the thread twitching.
      if (!item.text.trim()) return null;
      // Spacing and the side rails live on the cell: cells are positioned
      // individually, so a container `gap` would never apply, and horizontal
      // padding on the scroll content is not part of the list's layout math.
      return (
        <View style={index === 0 ? styles.firstRow : styles.row}>
          <Turn turn={item} />
        </View>
      );
    },
    [],
  );

  // Mirrored into a ref so the inset effect below can read "is the reader at the
  // end" without re-running every time the answer changes.
  const atBottom = useRef(true);

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      // Exactly the threshold the list itself follows appends at, so the chip
      // means "the transcript has stopped following you" and nothing else. A
      // tighter slack put it on screen for every streamed chunk: the reply grows
      // a line, the end briefly sits beyond the viewport, and the chip appeared
      // while the list was already scrolling to catch up.
      const next =
        contentOffset.y + layoutMeasurement.height >=
        contentSize.height - layoutMeasurement.height * FOLLOW_THRESHOLD;
      atBottom.current = next;
      onAtBottomChange(next);
    },
    [onAtBottomChange],
  );

  // The reading-area insets are real children, not `contentContainerStyle`.
  // FlashList v2 measures the scroll content itself, so padding on the content
  // container is not in that measurement: the transcript could be scrolled
  // under the composer and the last message sat behind it. A header and footer
  // are laid out like any other row, so the list knows they are there.
  const headerStyle = useMemo(() => ({ height: threadTop }), [threadTop]);
  const footerStyle = useMemo(() => ({ paddingBottom: threadBottom }), [threadBottom]);

  // The composer grows when it takes focus, and the dock it lives in is an
  // overlay pinned to the bottom edge — so it expands *upwards*, over the
  // transcript. Growing the footer reserves the room but does not consume it:
  // the content below the viewport gets taller while the visible rows stay
  // exactly where they were, now behind the composer. Taking up the new slack
  // is what keeps the last message clear of it.
  const list = useRef<ChatThreadRef>(null);
  useImperativeHandle(ref, () => list.current as ChatThreadRef, []);

  useEffect(() => {
    if (!atBottom.current) return;
    list.current?.scrollToEnd({ animated: true });
  }, [threadBottom]);

  return (
    <FlashList
      ref={list}
      data={turns}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      // Follow an append only while the reader is near the end. Someone reading
      // history keeps their place while the reply streams on below.
      maintainVisibleContentPosition={MAINTAIN_POSITION}
      ListHeaderComponent={SpacerOnly}
      ListHeaderComponentStyle={headerStyle}
      // A footer is always mounted, so the bottom inset survives the agent going
      // idle and the streaming dots never change the transcript's resting
      // position — they only replace a spacer of their own height.
      ListFooterComponent={working ? WorkingFooter : SpacerOnly}
      ListFooterComponentStyle={footerStyle}
      // Android supports only "none" and "on-drag"; passing iOS's "interactive"
      // there degrades to never dismissing at all, so dragging the transcript
      // would leave the keyboard up with no way down.
      keyboardDismissMode={DISMISS_MODE}
      keyboardShouldPersistTaps="handled"
      automaticallyAdjustsScrollIndicatorInsets={false}
      // The whole pane is lifted by one transform instead (see `useKeyboardLift`).
      // UIKit's own keyboard inset would be a second, differently-timed
      // adjustment on top of it. Both props are iOS-only and inert on Android,
      // where the library holds the window at a fixed size for the same reason.
      automaticallyAdjustKeyboardInsets={false}
      automaticallyAdjustContentInsets={false}
      scrollIndicatorInsets={{ top: indicatorTop, bottom: indicatorBottom }}
      scrollEventThrottle={16}
      onScroll={handleScroll}
    />
  );
}

/**
 * How near the end counts as following the conversation, as a fraction of the
 * viewport. Shared by the list's autoscroll and the jump-to-latest chip so the
 * two can never disagree about whether you are at the bottom.
 */
const FOLLOW_THRESHOLD = 0.2;

const MAINTAIN_POSITION = {
  startRenderingFromBottom: true,
  autoscrollToBottomThreshold: FOLLOW_THRESHOLD,
} as const;

const DISMISS_MODE = Platform.OS === "ios" ? "interactive" : "on-drag";

// `key` where the turn has one: an optimistic prompt's `id` is replaced by the
// server's when the echo lands, and keying on that would recycle the cell out
// from under a message that never changed.
const keyExtractor = (turn: TurnData) => turn.key ?? turn.id;

/** Carries only a `ListHeaderComponentStyle`/`ListFooterComponentStyle` inset. */
const SpacerOnly = () => null;

const WorkingFooter = () => <Working />;

/** Three dots that fade in sequence. Calm, and it costs no layout. */
function Working() {
  const one = useRef(new Animated.Value(0.25)).current;
  const two = useRef(new Animated.Value(0.25)).current;
  const three = useRef(new Animated.Value(0.25)).current;
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (reduceMotion) return;
    const dots = [one, two, three];
    const loops = dots.map((dot, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 160),
          Animated.timing(dot, { toValue: 1, duration: 320, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0.25, duration: 320, useNativeDriver: true }),
          Animated.delay((2 - index) * 160),
        ]),
      ),
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [reduceMotion, one, two, three]);

  return (
    // `accessible` groups the dots into one node; without it the label is
    // attached to a container VoiceOver never focuses.
    <View style={styles.workingRow} accessible accessibilityLabel="Agent is working">
      <Animated.View style={[styles.dot, { opacity: one }]} />
      <Animated.View style={[styles.dot, { opacity: two }]} />
      <Animated.View style={[styles.dot, { opacity: three }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  row: { paddingTop: theme.space(5), paddingHorizontal: theme.gutter },
  firstRow: { paddingTop: 0, paddingHorizontal: theme.gutter },
  // Sits on the same left rail as the agent text that replaces it, so the reply
  // does not jump horizontally when streaming begins.
  workingRow: {
    flexDirection: "row",
    gap: theme.space(1.5),
    alignItems: "center",
    height: theme.line.body,
    marginTop: theme.space(5),
    paddingHorizontal: theme.gutter,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.color.textDim,
  },
});

export const ChatThread = memo(forwardRef<ChatThreadRef, Props>(ChatThreadView));
