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
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { haptics } from "./haptics";
import type { ConfigOption } from "../useDaemon";
import { useReducedMotion } from "./useReducedMotion";
import { fitPickerToViewport } from "./pickerLayout";
import { Glass } from "./Glass";

/** Height of the top bar the picker hangs from: inset, control, inset. */
const TOP_BAR = theme.headerInset * 2 + theme.size.control;

/**
 * Ceiling for the menu. Short lists shrink to fit; an agent advertising a dozen
 * models scrolls inside this instead of running down the screen.
 */
const MAX_MENU_HEIGHT = 360;
const PREFERRED_MENU_WIDTH = 300;

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
  const viewport = useWindowDimensions();
  const menuTop = insets.top + TOP_BAR + theme.space(1.5);
  const menuLayout = fitPickerToViewport({
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    anchorX,
    menuTop,
    insets,
    margin: theme.gutter,
    preferredWidth: PREFERRED_MENU_WIDTH,
    maximumHeight: MAX_MENU_HEIGHT,
  });

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
          { paddingTop: menuTop },
          { paddingLeft: menuLayout.left },
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
              width: menuLayout.width,
              maxHeight: menuLayout.maxHeight,
              // A right-edge clamp should still feel attached to a pill near
              // that edge instead of growing in from the opposite corner.
              transformOrigin: menuLayout.origin,
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
          <Glass
            radius={theme.radius.lg}
            tier="raised"
            style={[styles.cardGlass, { maxHeight: menuLayout.maxHeight }]}
          >

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
                        // Selection, not impact: this is a value changing in a
                        // list, the same gesture family as a picker wheel.
                        haptics.select();
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
          </Glass>
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
    // Width and height are fitted against the live viewport before paint.
    alignSelf: "flex-start",
  },
  cardGlass: { width: "100%", flexShrink: 1 },
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
