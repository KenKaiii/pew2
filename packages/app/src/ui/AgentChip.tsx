/** Neutral provider controls retain the same native Glass press response. */
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { agentChipColors } from "../agentChipColors";
import { Glass } from "./Glass";
import { haptics } from "./haptics";
import type { Provider } from "../useDaemon";

interface AgentChipProps {
  provider: Provider;
  selected: boolean;
  onPress: (providerId: string) => void;
}
function AgentChipView({ provider, selected, onPress }: AgentChipProps) {
  const enabled = provider.available;
  const colors = agentChipColors(provider.color, selected, enabled, theme.color);
  return <Glass radius={theme.radius.pill} interactive={enabled} style={styles.chip}>
    <Pressable
      disabled={!enabled}
      accessibilityRole="button"
      accessibilityLabel={enabled ? provider.name : `${provider.name}, unavailable. ${provider.unavailableReason ?? ""}`}
      accessibilityState={{ selected, disabled: !enabled }}
      onPress={() => { haptics.select(); onPress(provider.id); }}
      style={[styles.body, { backgroundColor: colors.background }]}
    >
      <View accessible={false} style={[styles.marker, { backgroundColor: colors.marker }]} />
      <Text style={[styles.label, { color: colors.text }]} numberOfLines={1}>{provider.name}</Text>
      {selected && <Ionicons name="checkmark" size={16} color={colors.text} accessible={false} />}
    </Pressable>
  </Glass>;
}
const styles = StyleSheet.create({
  chip: { borderRadius: theme.radius.pill, overflow: "hidden" },
  body: { flexDirection: "row", alignItems: "center", justifyContent: "center", minHeight: theme.size.touch, paddingHorizontal: theme.space(4), paddingVertical: theme.space(1), gap: theme.space(2) },
  marker: { width: 7, height: 7, borderRadius: theme.radius.pill },
  label: { fontSize: theme.font.small, fontWeight: "700", lineHeight: theme.font.small + 4, maxWidth: 160 },
});
export const AgentChip = memo(AgentChipView, (before, after) =>
  before.selected === after.selected &&
  before.provider.id === after.provider.id &&
  before.provider.name === after.provider.name &&
  before.provider.color === after.provider.color &&
  before.provider.available === after.provider.available &&
  before.provider.unavailableReason === after.provider.unavailableReason &&
  before.onPress === after.onPress,
);
