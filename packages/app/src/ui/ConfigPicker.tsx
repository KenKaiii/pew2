/**
 * Model / thinking-level selector.
 *
 * Everything here comes from the agent's own `configOptions`, so connecting a
 * new app brings its models and reasoning levels with it and pew2 never carries
 * a hardcoded model list that would go stale.
 *
 * Values only: names, no descriptions. The point is to switch quickly, not to
 * read documentation.
 *
 * Anchored under the model pill in the top left and scaled from that corner, so
 * it reads as the pill opening rather than a dialog arriving from nowhere.
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
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import type { ConfigOption } from "../useDaemon";
import { useReducedMotion } from "./useReducedMotion";

/** Height of the top bar the picker hangs from: inset, control, inset. */
const TOP_BAR = theme.headerInset * 2 + theme.size.control;

/**
 * Ceiling for the menu. Short lists shrink to fit; an agent advertising a dozen
 * models scrolls inside this instead of running down the screen.
 */
const MAX_MENU_HEIGHT = 360;

/** Category order when the agent gives no explicit priority. */
const CATEGORY_RANK: Record<string, number> = {
  model: 0,
  model_config: 1,
  thought_level: 2,
  mode: 3,
};

// Slot assignment lives in a react-native-free module so it can be unit tested.
export { summarise, valueName } from "./configSlots";

interface ConfigPickerProps {
  visible: boolean;
  onClose: () => void;
  options: ConfigOption[];
  onSelect: (configId: string, value: string | boolean) => void;
  /** Left edge of the pill this menu belongs to, so it opens under that pill. */
  anchorX?: number;
}

export function ConfigPicker({
  visible,
  onClose,
  options,
  onSelect,
  anchorX,
}: ConfigPickerProps) {
  const progress = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReducedMotion();
  const insets = useSafeAreaInsets();

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
      <Animated.View
        style={[
          styles.host,
          { paddingTop: insets.top + TOP_BAR + theme.space(1.5) },
          { paddingLeft: anchorX ?? theme.gutter },
          { opacity: progress },
        ]}
      >
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
              // Grows out of the pill's own corner rather than its centre.
              transformOrigin: "top left",
              transform: [
                {
                  scale: progress.interpolate({
                    inputRange: [0, 1],
                    outputRange: [0.92, 1],
                  }),
                },
              ],
            },
          ]}
        >
          {/* Decorative layers must not swallow taps meant for the rows. */}
          <BlurView
            intensity={60}
            tint="dark"
            style={StyleSheet.absoluteFill}
            pointerEvents="none"
          />
          <View style={styles.cardTint} pointerEvents="none" />

          {/* Hugs its rows: without this the ScrollView fills maxHeight and
              leaves dead space under the last option. */}
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.cardInner}
            showsVerticalScrollIndicator={false}
          >
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
    // Anchored to the pill that opens it; the gutter is the default.
    alignItems: "flex-start",
  },
  card: {
    // Menu-width, not dialog-width: it holds short value names only.
    minWidth: 220,
    maxWidth: 300,
    maxHeight: MAX_MENU_HEIGHT,
    // Shrink to content; maxHeight is the ceiling, not the target.
    alignSelf: "flex-start",
    borderRadius: theme.radius.lg,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.glass.control.rim,
  },
  cardTint: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Opaque enough to carry body text over a busy thread, then lifted by the
    // same glass fill every other control uses.
    backgroundColor: "rgba(28,28,30,0.72)",
  },
  scroll: { flexGrow: 0 },
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
  rowPressed: { backgroundColor: theme.glass.fillPressed },
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
