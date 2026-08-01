/**
 * The slash command picker, as a sheet from the bottom edge.
 *
 * Commands come from the agent and vary by project — `.claude/commands`,
 * `.gg/commands` and its own built-ins — so this never assumes a fixed set.
 * `slashCommands.ts` decides which are offered here at all.
 *
 * A sheet rather than a popover above the composer: the list is worth browsing,
 * a command is a deliberate choice, and arriving from the edge the thumb is
 * already at makes it reachable one-handed. Five rows are visible and the rest
 * scroll, so the sheet is a consistent size regardless of the project.
 */
import { memo, useEffect, useRef, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { CircleButton, touchSlop } from "./controls";
import { useReducedMotion } from "./useReducedMotion";
import type { SlashCommand } from "../slashCommands";

/** Rows visible before the list scrolls. */
const VISIBLE_ROWS = 5;
const ROW_HEIGHT = 60;

interface CommandSheetProps {
  visible: boolean;
  commands: SlashCommand[];
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
}

function CommandSheetView({ visible, commands, onSelect, onClose }: CommandSheetProps) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  const [height, setHeight] = useState(0);
  // Kept mounted while animating out, then removed: an always-mounted overlay
  // would swallow every touch meant for the conversation behind it. Declared
  // with the other hooks, above any early return.
  const mounted = useMountedWhileVisible(visible, progress);

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(visible ? 1 : 0);
      return;
    }
    // A spring, not a duration. A sheet is a physical object arriving under the
    // thumb, and a fixed curve reads as a slide being played at you — the
    // travel is long enough here that the difference is the whole feel.
    // Critically damped: it settles without a bounce, which on a list of
    // commands would look like a toy rather than a control.
    const animation = Animated.spring(progress, {
      toValue: visible ? 1 : 0,
      damping: 26,
      stiffness: 260,
      mass: 0.9,
      // The interpolations below are pixel offsets, so the default thresholds
      // (tuned for unit-scale values) would settle a couple of points short.
      restDisplacementThreshold: 0.001,
      restSpeedThreshold: 0.01,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [visible, reduceMotion, progress]);

  if (!mounted) return null;

  // Only as tall as it needs to be, up to five rows. A short project should not
  // get a half-empty sheet.
  const listHeight = Math.min(commands.length, VISIBLE_ROWS) * ROW_HEIGHT;
  const scrolls = commands.length > VISIBLE_ROWS;

  return (
    <View style={styles.host}>
      {/* Tapping away is the primary dismissal, so the scrim is a control. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel="Dismiss commands"
        onPress={onClose}
      >
        <Animated.View style={[styles.scrim, { opacity: progress }]} />
      </Pressable>

      <Animated.View
        // Measured rather than estimated: the travel must be the sheet's real
        // height, or it starts partly on screen and appears to jump.
        onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        style={[
          styles.sheet,
          // The home indicator's clearance is inside the sheet, not under it, so
          // the content clears the indicator while the surface still reaches the
          // physical edge.
          { paddingBottom: insets.bottom + theme.space(3) },
          {
            transform: [
              {
                translateY: progress.interpolate({
                  inputRange: [0, 1],
                  // Exactly its own height, since it rests flush on the edge.
                  // Falls back to a generous estimate for the first frame,
                  // before `onLayout` has reported.
                  outputRange: [height || listHeight + theme.size.touch * 4, 0],
                }),
              },
            ],
          },
        ]}
      >
        {/* Affordance only: this sheet is dismissed by the close button or the
            scrim, so the grabber is not itself draggable. */}
        <View style={styles.grabber} />

        <View style={styles.header}>
          <CircleButton label="Close commands" onPress={onClose} size={theme.size.chip}>
            <Ionicons name="close" size={18} color={theme.color.text} />
          </CircleButton>
          <Text style={styles.title}>Commands</Text>
          {/* Balances the close button so the title stays optically centred. */}
          <View style={{ width: theme.size.chip }} />
        </View>

        <View style={styles.card}>
          <ScrollView
            style={{ height: listHeight }}
            showsVerticalScrollIndicator={scrolls}
            bounces={scrolls}
          >
            {commands.map((command, index) => (
              <Pressable
                key={command.name}
                style={({ pressed }) => [
                  styles.row,
                  // Hairline between rows, never under the last one: a rule at
                  // the card's edge reads as a broken border.
                  index < commands.length - 1 && styles.rowDivided,
                  pressed && styles.rowPressed,
                ]}
                hitSlop={touchSlop(theme.space(1))}
                accessibilityRole="button"
                accessibilityLabel={`Run ${command.name}. ${command.description}`}
                onPress={() => onSelect(command)}
              >
                <Text style={styles.name} numberOfLines={1}>
                  /{command.name}
                </Text>
                {!!command.description && (
                  <Text style={styles.description} numberOfLines={1}>
                    {command.description}
                  </Text>
                )}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </Animated.View>
    </View>
  );
}

/**
 * Mounted for as long as the sheet is on screen, including its exit.
 *
 * Unmounting on `visible === false` would cut the close animation; staying
 * mounted forever would put an invisible scrim over the conversation.
 */
function useMountedWhileVisible(visible: boolean, progress: Animated.Value) {
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    const id = progress.addListener(({ value }) => {
      if (value === 0) setMounted(false);
    });
    return () => progress.removeListener(id);
  }, [visible, progress]);

  return mounted;
}

const styles = StyleSheet.create({
  host: { ...StyleSheet.absoluteFillObject, zIndex: 20, justifyContent: "flex-end" },
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)" },
  // Inset left and right so the thread stays visible down both sides, but sat
  // on the bottom edge: a sheet rises *from* the screen edge, and a gap under
  // it would leave the home indicator stranded on the conversation behind.
  // Square where it meets that edge, for the same reason — rounding a corner
  // there implies a boundary the sheet does not actually have.
  sheet: {
    marginHorizontal: theme.gutter,
    backgroundColor: theme.color.surface,
    borderTopLeftRadius: theme.radius.pane,
    borderTopRightRadius: theme.radius.pane,
    paddingHorizontal: theme.space(3),
  },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.color.textFaint,
    marginTop: theme.space(2),
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.space(3),
  },
  title: {
    color: theme.color.text,
    fontSize: theme.font.title,
    fontWeight: "600",
  },
  card: {
    backgroundColor: theme.color.surfaceRaised,
    borderRadius: theme.radius.lg,
    overflow: "hidden",
  },
  row: {
    height: ROW_HEIGHT,
    justifyContent: "center",
    paddingHorizontal: theme.space(4),
    gap: theme.space(0.5),
  },
  rowDivided: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border,
  },
  rowPressed: { backgroundColor: theme.color.surfacePressed },
  name: {
    color: theme.color.text,
    fontSize: theme.font.body,
    fontWeight: "600",
  },
  description: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
  },
});

export const CommandSheet = memo(CommandSheetView);
