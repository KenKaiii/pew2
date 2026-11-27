/** Resting context row: one horizontally scrolling line of Stage LED chips —
 * Commands, project, usage warning, then GG's Checklist and Plan. (The
 * uncommitted count lives in the input, after the pills.)
 * Routine readings remain one tap away in the project-details sheet.
 */
import { memo } from "react";
import { ScrollView, StyleSheet } from "react-native";
import { theme } from "../theme";
import { contextDetails } from "../contextDetails";
import type { ContextUsage } from "../contextUsage";
import type { Workspace } from "../useDaemon";
import { StageChip, STAGE_CHIP_HEIGHT } from "./StageChip";
import { DotGlyph } from "./stage/DotGlyph";
import { Pixel } from "./stage/Pixel";

export interface ContextBarProps {
  workspace?: Workspace;
  usage?: ContextUsage;
  showCommands: boolean;
  onCommands: () => void;
  onDetails: () => void;
  /** GG Coder: the checklist chip, when this conversation has one. */
  onChecklist?: () => void;
  /** GG Coder: the project task list chip, when this conversation has one. */
  onTasks?: () => void;
  /** GG Coder: the agent is in plan mode. */
  planMode?: boolean;
}
function ContextBarView({
  workspace,
  usage,
  showCommands,
  onCommands,
  onDetails,
  onChecklist,
  onTasks,
  planMode,
}: ContextBarProps) {
  const details = contextDetails(workspace, usage);
  const critical = details.level === "critical";
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroll}
      contentContainerStyle={styles.row}
      keyboardShouldPersistTaps="handled"
    >
      {showCommands && (
        <StageChip
          label="Commands"
          accessibilityLabel="Show commands"
          onPress={onCommands}
          trailing={<DotGlyph name="chevron-down" size={10} color={theme.color.textDim} />}
        />
      )}
      <StageChip
        label={workspace?.folder || "Project"}
        maxLabelWidth={140}
        accessibilityLabel={`${details.project}. Show project details`}
        onPress={onDetails}
        trailing={<DotGlyph name="chevron-down" size={10} color={theme.color.textDim} />}
      />
      {details.warning && (
        <StageChip
          label={details.usage}
          lit
          tone={critical ? "danger" : "attention"}
          leading={<Pixel kind="attention" color={critical ? theme.color.danger : undefined} />}
          accessibilityLabel={details.usageAccessibility}
        />
      )}
      {onChecklist && (
        <StageChip
          label="Checklist"
          accessibilityLabel="Checklist"
          onPress={onChecklist}
          leading={<Pixel kind="unread" />}
        />
      )}
      {onTasks && (
        <StageChip
          label="Tasks"
          accessibilityLabel="Tasks"
          onPress={onTasks}
          leading={<Pixel kind="unread" />}
        />
      )}
      {planMode && (
        <StageChip
          label="Plan mode"
          lit
          accessibilityLabel="Plan mode"
          leading={<Pixel kind="live" />}
        />
      )}
    </ScrollView>
  );
}
export const ContextBar = memo(ContextBarView);
const styles = StyleSheet.create({
  scroll: { flexGrow: 0, marginBottom: theme.space(3), minHeight: STAGE_CHIP_HEIGHT },
  row: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
});
