/**
 * What the agent is doing, right now, in one line.
 *
 * The transcript's footer used to be three fading dots: honest, but it says
 * only "something is happening" for what can be minutes of work on a machine
 * the user cannot see. The agent already reports every tool it calls, so this
 * names the current one instead — and lights it with a travelling gradient,
 * which is what separates "still working" from a line that has stalled.
 *
 * It is deliberately one row at the transcript's left rail, exactly where the
 * reply will begin: the answer lands where the activity was, so nothing shifts
 * when the work turns into text. And it exits the moment the turn is over —
 * `ui/TurnReceipt.tsx` takes its place with what actually happened.
 */
import { memo, useEffect, useRef } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { currentTool, queuedTools, type Activity, type ToolKind } from "../activity";
import { ShimmerText } from "./ShimmerText";
import { useReducedMotion } from "./useReducedMotion";

/**
 * One glyph per ACP tool kind, so a glance at the icon says what class of work
 * is happening even before the title is read.
 */
const ICONS: Record<ToolKind, keyof typeof Ionicons.glyphMap> = {
  read: "document-text-outline",
  edit: "create-outline",
  delete: "trash-outline",
  move: "arrow-forward-outline",
  search: "search-outline",
  execute: "terminal-outline",
  think: "bulb-outline",
  fetch: "cloud-download-outline",
  other: "ellipsis-horizontal",
};

/** Continuous, and slower than the composer's badge: this runs for minutes. */
const SWEEP_DURATION = 2200;

/** Crossfade when the agent moves to the next tool. Fast enough to feel live. */
const SWAP_DURATION = 160;

/** Where a swap fades from. Never to zero: the row must not appear to blink out. */
const SWAP_FROM = 0.35;

function ActivityLineView({ activity }: { activity: Activity }) {
  const tool = currentTool(activity);
  const queued = queuedTools(activity);
  const reduceMotion = useReducedMotion();

  const fade = useRef(new Animated.Value(1)).current;
  // The row is one component reused across tools rather than one per tool, so
  // the swap is animated here instead of by mounting: remounting would restart
  // the sheen mid-sweep and read as a stutter.
  const shown = useRef<string | undefined>(tool?.id);
  useEffect(() => {
    if (tool?.id === shown.current) return;
    shown.current = tool?.id;
    if (reduceMotion) return;
    fade.setValue(SWAP_FROM);
    Animated.timing(fade, {
      toValue: 1,
      duration: SWAP_DURATION,
      useNativeDriver: true,
    }).start();
  }, [fade, reduceMotion, tool?.id]);

  const title = tool?.title?.trim() || "Working";
  const kind = tool?.kind ?? "other";

  return (
    <Animated.View
      style={[styles.row, { opacity: fade }]}
      // Grouped into one node, and announced when it changes rather than
      // stealing focus: this is progress, not something to act on.
      accessible
      accessibilityLiveRegion="polite"
      accessibilityLabel={queued > 0 ? `${title}, and ${queued} more` : title}
    >
      <Ionicons name={ICONS[kind]} size={13} color={theme.color.textFaint} style={styles.icon} />
      <View style={styles.label}>
        <ShimmerText
          text={title}
          color={theme.color.textDim}
          size={theme.font.small}
          lineHeight={theme.line.body}
          weight="500"
          duration={SWEEP_DURATION}
          numberOfLines={1}
        />
      </View>
      {/* Agents run tools in parallel. Naming one and counting the rest keeps
          the line a single readable row instead of a scrolling log. */}
      {queued > 0 && <Text style={styles.queued}>+{queued}</Text>}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  // Mirrors `ChatThread`'s dot row so replacing one with the other never moves
  // the transcript, horizontally or vertically.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1.5),
    height: theme.line.body,
    marginTop: theme.space(5),
    paddingHorizontal: theme.gutter,
  },
  // Optical centring: the outline glyphs sit a hair high against lowercase text.
  icon: { marginTop: 1 },
  // Shrinks so a long tool title truncates instead of pushing the count off the
  // edge of the screen.
  label: { flexShrink: 1 },
  queued: {
    fontSize: theme.font.tiny,
    fontWeight: "600",
    color: theme.color.textFaint,
  },
});

export const ActivityLine = memo(ActivityLineView);
