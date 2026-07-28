/**
 * Shared control primitives.
 *
 * Every interactive surface in the app is one of these three shapes, so press
 * feedback, radii, touch targets and disabled treatment stay identical
 * everywhere rather than being re-styled per screen.
 */
import type { ReactNode } from "react";
import { Pressable, StyleSheet, Text, View, type ViewStyle } from "react-native";
import { theme } from "../theme";
import { Glass } from "./Glass";

/** Expands a sub-44pt control to the platform minimum touch target. */
export function touchSlop(size: number) {
  const slop = Math.max(0, (theme.size.touch - size) / 2);
  return { top: slop, bottom: slop, left: slop, right: slop };
}

interface CircleButtonProps {
  onPress: () => void;
  label: string;
  children: ReactNode;
  size?: number;
  disabled?: boolean;
  tint?: string;
  style?: ViewStyle;
}

/** Round icon button: menu, send, composer actions. */
export function CircleButton({
  onPress,
  label,
  children,
  size = theme.size.control,
  disabled = false,
  tint,
  style,
}: CircleButtonProps) {
  // A solid tint opts out of glass: used where a control must read as filled.
  if (tint) {
    return (
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        hitSlop={touchSlop(size)}
        style={({ pressed }) => [
          styles.circle,
          { width: size, height: size, borderRadius: size / 2, backgroundColor: tint },
          pressed && !disabled && styles.pressed,
          disabled && styles.disabled,
          style,
        ]}
      >
        {children}
      </Pressable>
    );
  }

  return (
    <Glass radius={size / 2} style={[{ width: size, height: size }, style]}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        hitSlop={touchSlop(size)}
        style={({ pressed }) => [
          styles.circle,
          { width: size, height: size },
          pressed && !disabled && styles.pressedOverlay,
          disabled && styles.disabled,
        ]}
      >
        {children}
      </Pressable>
    </Glass>
  );
}

interface PillProps {
  onPress?: () => void;
  label: string;
  children: ReactNode;
  disabled?: boolean;
}

/** Horizontal pill: the provider selector and the quick-action chips. */
export function Pill({ onPress, label, children, disabled = false }: PillProps) {
  const content = <View style={styles.pillRow}>{children}</View>;

  if (!onPress) {
    return (
      <Glass radius={theme.radius.pill}>
        <View style={styles.pill} accessibilityLabel={label}>
          {content}
        </View>
      </Glass>
    );
  }

  return (
    <Glass radius={theme.radius.pill}>
      <Pressable
        onPress={onPress}
        disabled={disabled}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ disabled }}
        style={({ pressed }) => [
          styles.pill,
          pressed && !disabled && styles.pressedOverlay,
          disabled && styles.disabled,
        ]}
      >
        {content}
      </Pressable>
    </Glass>
  );
}

/** Small muted caption used inside pills and rows. */
export function Caption({ children }: { children: ReactNode }) {
  return <Text style={styles.caption}>{children}</Text>;
}

const styles = StyleSheet.create({
  circle: { alignItems: "center", justifyContent: "center" },
  pill: {
    height: theme.size.control,
    paddingHorizontal: theme.space(4),
    justifyContent: "center",
  },
  pillRow: { flexDirection: "row", alignItems: "center", gap: theme.space(1.5) },
  pressed: { backgroundColor: theme.color.surfacePressed },
  // On glass, press brightens the surface rather than replacing its colour.
  pressedOverlay: { backgroundColor: "rgba(255,255,255,0.10)" },
  disabled: { opacity: 0.4 },
  caption: { color: theme.color.textDim, fontSize: theme.font.small },
});
