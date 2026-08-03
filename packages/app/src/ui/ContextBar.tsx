/**
 * The row above the composer: what this prompt is about to act on.
 *
 * A phone shows no filesystem, so before sending an instruction there is
 * nothing on screen saying *which* project the agent is in or whether the tree
 * is already dirty — the two facts that decide whether "commit this" or "revert
 * that" is safe. They live here, beside the Commands button, because this is
 * the last thing under the eye before the send button.
 *
 * Read-only by design: nothing here is a control, so it can never eat a tap
 * meant for the composer. Only the project name and the change count are shown
 * (never the full path) — `/Users/me/gg-projects/pew2` is noise at this size,
 * and `pew2` is how people name the thing they are working on.
 */
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { touchSlop } from "./controls";
import { changesAccessibilityLabel, changesLabel } from "../workspaceLabel";
import type { Workspace } from "../useDaemon";

export interface ContextBarProps {
  /** Absent until the daemon answers, or while switching conversations. */
  workspace?: Workspace;
  /** Commands button is offered only when the agent actually has some. */
  showCommands: boolean;
  onCommands: () => void;
}

function ContextBarView({ workspace, showCommands, onCommands }: ContextBarProps) {
  // Uncommitted work is the state worth noticing, so it takes the warm accent;
  // a clean tree is confirmation, not a warning, and stays green.
  const dirty = (workspace?.uncommitted ?? 0) > 0;
  const changeColor = dirty ? theme.color.accent : theme.color.success;

  return (
    <View style={styles.row}>
      {showCommands && (
        <Pressable
          style={({ pressed }) => [styles.chip, pressed && styles.chipPressed]}
          hitSlop={touchSlop(theme.space(1))}
          accessibilityRole="button"
          accessibilityLabel="Show commands"
          onPress={onCommands}
        >
          <Ionicons name="flash-outline" size={14} color={theme.color.textDim} />
          <Text style={styles.label}>Commands</Text>
        </Pressable>
      )}

      {workspace && (
        <View
          style={styles.chip}
          accessibilityRole="text"
          accessibilityLabel={`Project ${workspace.folder}`}
        >
          <Ionicons name="folder-outline" size={14} color={theme.color.textDim} />
          {/* Truncated rather than wrapped: the row is one line high, and a
              long folder name must not push the git chip off screen. */}
          <Text style={[styles.label, styles.folder]} numberOfLines={1}>
            {workspace.folder}
          </Text>
        </View>
      )}

      {workspace?.repo && (
        <View
          style={styles.chip}
          accessibilityRole="text"
          accessibilityLabel={changesAccessibilityLabel(workspace.uncommitted)}
        >
          {/* A dot, not an icon: the colour is the message, and a glyph at this
              size only competes with the two icons already in the row. */}
          <View style={[styles.dot, { backgroundColor: changeColor }]} />
          <Text style={[styles.label, { color: changeColor }]}>
            {changesLabel(workspace.uncommitted)}
          </Text>
        </View>
      )}
    </View>
  );
}

/**
 * Memoized: this sits inside the dock, which re-renders on every keystroke of
 * the draft, while its own inputs change only when a turn ends.
 */
export const ContextBar = memo(ContextBarView);

const styles = StyleSheet.create({
  // Left-aligned with the thread's text rail, so the row reads as belonging to
  // the conversation rather than to the input below it.
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    marginBottom: theme.space(2),
  },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1),
    height: theme.size.control,
    paddingHorizontal: theme.space(3),
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.surface,
  },
  chipPressed: { backgroundColor: theme.color.surfacePressed },
  label: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    fontWeight: "600",
  },
  // The project name is the row's subject, so it is the one item in full text
  // colour; the ceiling keeps it from crowding out the change count.
  folder: { color: theme.color.text, maxWidth: 140 },
  dot: { width: 7, height: 7, borderRadius: 4 },
});
