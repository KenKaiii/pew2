/**
 * The row above the composer: what this prompt is about to act on.
 *
 * A phone shows no filesystem, so before sending an instruction there is
 * nothing on screen saying *which* project the agent is in, whether the tree is
 * already dirty, or how close the agent is to compacting away what it was told
 * ten minutes ago. Those are the facts that decide whether "commit this" or
 * "revert that" is safe, and whether it is worth starting something long.
 *
 * Read-only by design apart from Commands, so it can never eat a tap meant for
 * the composer. Only the project *name* is shown, never the full path —
 * `/Users/me/gg-projects/pew2` is noise at this size, and `pew2` is how people
 * name the thing they are working on.
 *
 * No icons. Four facts on one phone-width line leaves no room for glyphs that
 * only restate their own label: a folder icon beside a folder name is a
 * tautology costing about 20pt each. Separated by hairline rules instead, which
 * cost one pixel and group the row as a single object rather than four
 * competing pills.
 *
 * **The row never wraps.** It is one line by contract — the dock's height is
 * computed around it, so a second line pushes the composer down and re-lays out
 * the thread. Everything is `numberOfLines={1}`, nothing may shrink below its
 * text, and the project name is the single elastic element: it is the only item
 * whose meaning survives truncation, since `acme-storefr…` still identifies the
 * project while `9 uncommi…` is gibberish and a clipped percentage is a
 * different number.
 */
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { touchSlop } from "./controls";
import { changesAccessibilityLabel, changesLabel } from "../workspaceLabel";
import {
  usageAccessibilityLabel,
  usageLabel,
  usageLevel,
  usagePercent,
  type ContextUsage,
} from "../contextUsage";
import type { Workspace } from "../useDaemon";

export interface ContextBarProps {
  /** Absent until the daemon answers, or while switching conversations. */
  workspace?: Workspace;
  /** Absent for agents that never report it, and the row then omits it. */
  usage?: ContextUsage;
  /** Commands button is offered only when the agent actually has some. */
  showCommands: boolean;
  onCommands: () => void;
}

function ContextBarView({
  workspace,
  usage,
  showCommands,
  onCommands,
}: ContextBarProps) {
  // Uncommitted work is the state worth noticing, so it takes the warm accent;
  // a clean tree is confirmation, not a warning, and stays green.
  const dirty = (workspace?.uncommitted ?? 0) > 0;
  const changeColor = dirty ? theme.color.accent : theme.color.success;

  // The colour *is* the warning, which is why the percentage carries it rather
  // than sitting beside a separate indicator: at a glance the row should read
  // as "fine" or "not fine" before any number is actually parsed.
  const percent = usage ? usagePercent(usage) : 0;
  const usageColor = usage
    ? {
        normal: theme.color.textDim,
        high: theme.color.accent,
        critical: theme.color.danger,
      }[usageLevel(percent)]
    : theme.color.textDim;

  // Built as a list so the separators fall *between* items: with Commands
  // hidden, or an agent reporting no usage, a hardcoded rule would leave a
  // stray hairline against the row's edge.
  //
  // `elastic` travels with the item because the cell wrapping it must shrink
  // too — a rigid parent around a shrinkable child squeezes nothing.
  const items: Array<{ node: React.ReactNode; elastic?: boolean }> = [];

  if (showCommands) {
    items.push({
      node: (
        <Pressable
          style={({ pressed }) => [styles.item, pressed && styles.itemPressed]}
          hitSlop={touchSlop(theme.space(2))}
          accessibilityRole="button"
          accessibilityLabel="Show commands"
          onPress={onCommands}
        >
          <Text style={styles.label} numberOfLines={1}>
            Commands
          </Text>
          {/* The one item here that opens something, and the only clue that it
              is tappable at all: everything to its right is inert text in the
              same size and weight. Trailing, so it reads as "leads onward"
              rather than decorating the word. */}
          <Ionicons
            name="chevron-forward"
            size={12}
            color={theme.color.textDim}
            style={styles.chevron}
          />
        </Pressable>
      ),
    });
  }

  if (workspace) {
    items.push({
      elastic: true,
      node: (
        <View
          style={[styles.item, styles.elasticCell]}
          accessibilityRole="text"
          accessibilityLabel={`Project ${workspace.folder}`}
        >
          {/* Truncated rather than wrapped: the row is one line high, and a long
            folder name must not push the reading off screen. */}
          <Text style={[styles.label, styles.folder]} numberOfLines={1}>
            {workspace.folder}
          </Text>
        </View>
      ),
    });
  }

  if (usage) {
    items.push({
      node: (
        <View
          style={styles.item}
          accessibilityRole="text"
          accessibilityLabel={usageAccessibilityLabel(usage)}
        >
          {/* Percent only. Tokens are a unit nobody has an intuition for, and
            "21,325 / 1,000,000" would take the width of everything else here. */}
          <Text style={[styles.label, { color: usageColor }]} numberOfLines={1}>
            {usageLabel(usage)}
          </Text>
        </View>
      ),
    });
  }

  if (workspace?.repo) {
    items.push({
      node: (
        <View
          style={styles.item}
          accessibilityRole="text"
          accessibilityLabel={changesAccessibilityLabel(workspace.uncommitted)}
        >
          <Text
            style={[styles.label, { color: changeColor }]}
            numberOfLines={1}
          >
            {changesLabel(workspace.uncommitted)}
          </Text>
        </View>
      ),
    });
  }

  return (
    <View style={styles.row}>
      {items.map((item, index) => (
        <View
          key={index}
          style={[styles.cell, item.elastic && styles.elasticCell]}
        >
          {index > 0 && <View style={styles.separator} />}
          {item.node}
        </View>
      ))}
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
    // Enough air that the row reads as its own line rather than as a label
    // stuck to the top of the input. It describes what the prompt will act on,
    // which is a different thought from the prompt itself.
    marginBottom: theme.space(4),
    // No-wrap means overflow is the failure mode, so it is clipped at the rail
    // rather than spilling past the gutter into the screen edge. Reached only
    // when the project name has already shrunk to its floor.
    overflow: "hidden",
  },
  // Holds the separator and its item together, so the rule travels with the
  // item it precedes rather than being positioned against the row.
  //
  // `flexShrink: 0` is the no-wrap contract: a shrinkable cell is squeezed
  // narrower than its text, and RN then breaks that text onto a second line
  // instead of clipping it. Only the folder cell may give way, below.
  cell: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
  separator: {
    width: StyleSheet.hairlineWidth,
    // Short of the row's full height: a rule that spans the line reads as a
    // table border, while a stub reads as a separator.
    height: theme.font.small,
    backgroundColor: theme.color.border,
    marginHorizontal: theme.space(3),
  },
  item: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
  // The one elastic item. Its label truncates with an ellipsis, which still
  // names the project; every other item would become unreadable or, worse,
  // read as a different number. `minWidth: 0` is required for a flex child to
  // be allowed narrower than its content at all.
  elasticCell: { flexShrink: 1, minWidth: 0 },
  // The only tappable thing in the row, so it gets the feedback; the others
  // must stay visually inert or they read as broken buttons.
  itemPressed: { opacity: 0.6 },
  label: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    fontWeight: "600",
  },
  // Tight to the word it belongs to, and nudged off the text's own baseline
  // slack so it centres against the glyphs rather than the line box.
  chevron: { marginLeft: theme.space(1) },
  // The project name is the row's subject, so it is the one item in full text
  // colour; the ceiling keeps it from crowding out everything to its right.
  folder: { color: theme.color.text, maxWidth: 120, flexShrink: 1 },
});
