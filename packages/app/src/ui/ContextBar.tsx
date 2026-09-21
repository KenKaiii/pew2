/** Resting context row: actions, project, and only actionable warnings.
 * Routine readings remain one tap away in the project-details sheet.
 * The project stays single-line; large text can wrap the row, not hide warnings.
 */
import { memo } from "react";
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { contextDetails } from "../contextDetails";
import type { ContextUsage } from "../contextUsage";
import type { Workspace } from "../useDaemon";

export interface ContextBarProps {
  workspace?: Workspace;
  usage?: ContextUsage;
  showCommands: boolean;
  onCommands: () => void;
  onDetails: () => void;
}
function ContextBarView({ workspace, usage, showCommands, onCommands, onDetails }: ContextBarProps) {
  const details = contextDetails(workspace, usage);
  const { fontScale } = useWindowDimensions();
  // Keep each control on one line, but let the row grow at accessibility text
  // sizes rather than clipping commands or safety warnings off the screen.
  const largeText = fontScale > 1.2;
  const warningColor = details.level === "critical" ? theme.color.danger : theme.color.accent;
  const items: Array<{ key: string; node: React.ReactNode; elastic?: boolean }> = [];
  if (showCommands) items.push({ key: "commands", node: <Pressable style={({ pressed }) => [styles.item, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel="Show commands" onPress={onCommands}>
    <Text style={styles.label} numberOfLines={1}>Commands</Text>
    <Ionicons name="chevron-forward" size={12} color={theme.color.textDim} style={styles.chevron} />
  </Pressable> });
  items.push({ key: "project", elastic: true, node: <Pressable style={({ pressed }) => [styles.item, styles.project, pressed && styles.pressed]} accessibilityRole="button" accessibilityLabel={`${details.project}. Show project details`} onPress={onDetails}>
    <Text style={[styles.label, styles.folder]} numberOfLines={1}>{workspace?.folder || "Project"}</Text>
    <Ionicons name="chevron-forward" size={12} color={theme.color.textDim} style={styles.chevron} />
  </Pressable> });
  if (details.warning) items.push({ key: "usage", node: <View style={styles.item} accessibilityRole="text" accessibilityLabel={details.usageAccessibility}>
    <Ionicons name="warning-outline" size={14} color={warningColor} style={styles.warning} />
    <Text style={[styles.label, { color: warningColor }]} numberOfLines={1}>{details.usage}</Text>
  </View> });
  if (details.dirty) items.push({ key: "changes", node: <View style={styles.item} accessibilityRole="text" accessibilityLabel={details.changesAccessibility}>
    <Ionicons name="git-compare-outline" size={14} color={theme.color.accent} style={styles.warning} accessible={false} />
    <Text style={[styles.label, { color: theme.color.accent }]} numberOfLines={1}>{workspace?.uncommitted}</Text>
  </View> });
  return <View style={[styles.row, largeText && styles.largeText]}>{items.map((item, index) => <View key={item.key} style={[styles.cell, item.elastic && styles.elastic]}>
    {index > 0 && !largeText && <View style={styles.separator} />}{item.node}
  </View>)}</View>;
}
export const ContextBar = memo(ContextBarView);
const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", marginBottom: theme.space(4) },
  cell: { flexDirection: "row", alignItems: "center", flexShrink: 0 },
  largeText: { flexWrap: "wrap", columnGap: theme.space(3), rowGap: theme.space(1) },
  separator: { width: StyleSheet.hairlineWidth, height: theme.font.small, backgroundColor: theme.color.border, marginHorizontal: theme.space(1) },
  item: { flexDirection: "row", alignItems: "center", flexShrink: 0, minHeight: theme.size.touch },
  elastic: { flexShrink: 1, minWidth: theme.size.touch },
  project: { flexShrink: 1, minWidth: theme.size.touch, paddingRight: theme.space(1) },
  pressed: { opacity: 0.6 },
  label: { color: theme.color.textDim, fontSize: theme.font.small, lineHeight: 17, fontWeight: "600" },
  chevron: { marginLeft: theme.space(1) },
  warning: { marginRight: theme.space(1) },
  folder: { color: theme.color.text, maxWidth: 120, flexShrink: 1 },
});
