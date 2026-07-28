/**
 * Model / thinking-level selector.
 *
 * Everything here comes from the agent's own `configOptions`, so connecting a
 * new app brings its models and reasoning levels with it and pew2 never carries
 * a hardcoded model list that would go stale.
 *
 * Values only: names, no descriptions. The point is to switch quickly, not to
 * read documentation.
 */
import { useEffect, useRef } from "react";
import {
  Animated,
  Easing,
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { BlurView } from "expo-blur";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import type { ConfigOption } from "../useDaemon";
import { useReducedMotion } from "./useReducedMotion";

/** Category order when the agent gives no explicit priority. */
const CATEGORY_RANK: Record<string, number> = {
  model: 0,
  model_config: 1,
  thought_level: 2,
  mode: 3,
};

/** The label shown in the top bar: current model, then thinking level. */
export function summarise(options: ConfigOption[]): {
  primary?: ConfigOption;
  secondary?: ConfigOption;
} {
  const selectable = options.filter((o) => o.type === "select" && o.options?.length);
  const byCategory = (category: string) =>
    selectable.find((o) => o.category === category);

  return {
    primary: byCategory("model") ?? selectable[0],
    secondary: byCategory("thought_level"),
  };
}

export function valueName(option?: ConfigOption): string | undefined {
  if (!option) return undefined;
  const match = option.options?.find((v) => v.value === option.currentValue);
  return match?.name ?? String(option.currentValue);
}

interface ConfigPickerProps {
  visible: boolean;
  onClose: () => void;
  options: ConfigOption[];
  onSelect: (configId: string, value: string | boolean) => void;
}

export function ConfigPicker({
  visible,
  onClose,
  options,
  onSelect,
}: ConfigPickerProps) {
  const progress = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const animation = Animated.timing(progress, {
      toValue: visible ? 1 : 0,
      duration: reduceMotion ? 0 : theme.motion.base,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [visible, reduceMotion, progress]);

  const sorted = [...options]
    .filter((option) => option.type === "select" && option.options?.length)
    .sort(
      (a, b) =>
        (CATEGORY_RANK[a.category ?? ""] ?? 90) -
        (CATEGORY_RANK[b.category ?? ""] ?? 90),
    );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onClose}
    >
      <Animated.View style={[styles.host, { opacity: progress }]}>
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel="Close picker"
          onPress={onClose}
        />

        <Animated.View
          style={[
            styles.card,
            {
              transform: [
                {
                  // Scales up from just under full size: a settle, not a slide.
                  scale: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.96, 1],
                  }),
                },
              ],
            },
          ]}
        >
          <BlurView intensity={60} tint="dark" style={StyleSheet.absoluteFill} />
          <View style={styles.cardTint} />

          <ScrollView contentContainerStyle={styles.cardInner}>
            {sorted.length === 0 && (
              <Text style={styles.empty}>
                This agent offers no model options.
              </Text>
            )}

            {sorted.map((option) => (
              <View key={option.id} style={styles.group}>
                <Text style={styles.groupLabel}>{option.name}</Text>
                {option.options?.map((value) => {
                  const selected = value.value === option.currentValue;
                  return (
                    <Pressable
                      key={value.value}
                      accessibilityRole="button"
                      accessibilityLabel={value.name}
                      accessibilityState={{ selected }}
                      onPress={() => {
                        onSelect(option.id, value.value);
                        onClose();
                      }}
                      style={({ pressed }) => [
                        styles.row,
                        pressed && styles.rowPressed,
                      ]}
                    >
                      <Text style={styles.rowText}>{value.name}</Text>
                      {selected && (
                        <Ionicons
                          name="checkmark"
                          size={18}
                          color={theme.color.text}
                        />
                      )}
                    </Pressable>
                  );
                })}
              </View>
            ))}
          </ScrollView>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  host: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.55)",
    justifyContent: "center",
    paddingHorizontal: theme.space(6),
  },
  card: {
    maxHeight: "70%",
    borderRadius: theme.radius.lg,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.14)",
  },
  cardTint: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(28,28,32,0.55)",
  },
  cardInner: { padding: theme.space(3) },
  group: { paddingBottom: theme.space(3) },
  groupLabel: {
    color: theme.color.textDim,
    fontSize: theme.font.tiny,
    letterSpacing: 0.8,
    textTransform: "uppercase",
    paddingHorizontal: theme.space(3),
    paddingBottom: theme.space(1.5),
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: theme.size.touch,
    paddingHorizontal: theme.space(3),
    borderRadius: theme.radius.md,
  },
  rowPressed: { backgroundColor: "rgba(255,255,255,0.10)" },
  rowText: {
    color: theme.color.text,
    fontSize: theme.font.body,
    lineHeight: theme.line.body,
  },
  empty: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    padding: theme.space(4),
  },
});
