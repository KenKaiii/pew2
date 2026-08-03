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
 *
 * The chrome — travel, grabber, header — is `Sheet`, shared with the thinking
 * and approval sheets so all three read as the same object.
 */
import { memo } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { theme } from "../theme";
import { touchSlop } from "./controls";
import { Sheet, SHEET_ROW_HEIGHT, SHEET_VISIBLE_ROWS, sheetCardStyle } from "./Sheet";
import type { SlashCommand } from "../slashCommands";

interface CommandSheetProps {
  visible: boolean;
  commands: SlashCommand[];
  onSelect: (command: SlashCommand) => void;
  onClose: () => void;
}

function CommandSheetView({ visible, commands, onSelect, onClose }: CommandSheetProps) {
  // Only as tall as it needs to be, up to five rows. A short project should not
  // get a half-empty sheet.
  const listHeight = Math.min(commands.length, SHEET_VISIBLE_ROWS) * SHEET_ROW_HEIGHT;
  const scrolls = commands.length > SHEET_VISIBLE_ROWS;

  return (
    <Sheet visible={visible} title="Commands" onClose={onClose} dismissLabel="Close commands">
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
    </Sheet>
  );
}

const styles = StyleSheet.create({
  card: sheetCardStyle,
  row: {
    height: SHEET_ROW_HEIGHT,
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
