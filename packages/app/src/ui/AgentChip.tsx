/**
 * One agent's pill in the drawer.
 *
 * `Glass interactive` is the outer layer, and that is the whole point of this
 * component. It is Apple's liquid-glass material, and `isInteractive` is what
 * gives every control in this app its press response — the squish and settle
 * you feel when touching a selector. These pills had it, lost it when the flat
 * chip became a coloured gradient, and a hand-rolled Reanimated spring put in
 * its place felt nothing like its neighbours. The system effect is not worth
 * reimplementing: it is tuned per device, respects Reduce Motion, and is
 * already what the rest of the drawer does.
 *
 * The gradient sits *inside* the glass rather than replacing it. The material
 * is then hidden behind an opaque fill and contributes no blur, which is fine —
 * it is here for the interaction, and the interaction applies to everything it
 * contains.
 *
 * Its own file so the pill can be memoised: the drawer re-renders on every
 * conversation update, and inline chips re-rendered with it.
 */
import { memo } from "react";
import { Pressable, StyleSheet, Text } from "react-native";
import { LinearGradient } from "expo-linear-gradient";
import { theme } from "../theme";
import { providerFill } from "./providerGradient";
import { Glass } from "./Glass";
import { haptics } from "./haptics";
import type { Provider } from "../useDaemon";

/** Top-left to bottom-right, so the lit edge matches every other lit edge. */
const FILL_START = { x: 0, y: 0 } as const;
const FILL_END = { x: 1, y: 1 } as const;

/**
 * The glass highlight laid over an agent's fill.
 *
 * Mirrors `BLUR_HIGHLIGHT` in `Glass.tsx` — white at the top-left corner, gone
 * by the middle — so these catch light on the same edge as the selectors and
 * the composer. Weaker than the glass version because it sits on a saturated
 * colour rather than a dark surface, where the same values wash the hue out
 * instead of lighting it.
 */
const SHEEN = [
  "rgba(255,255,255,0.24)",
  "rgba(255,255,255,0.06)",
  "rgba(255,255,255,0)",
] as const;
const SHEEN_STOPS = [0, 0.45, 1] as const;
const SHEEN_END = { x: 0.9, y: 1 } as const;

interface AgentChipProps {
  provider: Provider;
  selected: boolean;
  onPress: (providerId: string) => void;
}

function AgentChipView({ provider, selected, onPress }: AgentChipProps) {
  const fill = providerFill(provider.color ?? theme.color.orb);
  const enabled = provider.available;

  return (
    <Glass
      radius={theme.radius.pill}
      interactive={enabled}
      style={[
        styles.chip,
        // Selection dims the others rather than decorating the current one. A
        // rim would be a border back on a shape whose whole point is that its
        // colour is the boundary.
        !selected && styles.idle,
        !enabled && styles.disabled,
      ]}
    >
      <LinearGradient
        colors={fill.colors}
        start={FILL_START}
        end={FILL_END}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <LinearGradient
        colors={SHEEN}
        locations={SHEEN_STOPS}
        start={FILL_START}
        end={SHEEN_END}
        style={StyleSheet.absoluteFill}
        pointerEvents="none"
      />
      <Pressable
        disabled={!enabled}
        accessibilityRole="button"
        accessibilityLabel={
          enabled
            ? provider.name
            : `${provider.name}, unavailable. ${provider.unavailableReason ?? ""}`
        }
        accessibilityState={{ selected, disabled: !enabled }}
        onPress={() => {
          haptics.select();
          onPress(provider.id);
        }}
        // No pressed style. The glass owns the press, and a dim or a wash laid
        // on top fights the material's own animation — which is exactly how
        // these came to look broken.
        style={styles.body}
      >
        <Text style={[styles.label, { color: fill.label }]} numberOfLines={1}>
          {provider.name}
        </Text>
      </Pressable>
    </Glass>
  );
}

const styles = StyleSheet.create({
  /**
   * Clips the fill to the pill. `Glass` rounds its own corners, but the
   * gradient is an absolutely-positioned child and would square them off again.
   */
  chip: { borderRadius: theme.radius.pill, overflow: "hidden" },
  /**
   * Every agent that is not the current one.
   *
   * A clear 30% step down. 0.88 was tried first and it was invisible — selected
   * and unselected read as the same pill, which is no selection cue at all.
   * Still well clear of the disabled 0.4, because "another agent you could
   * switch to" and "an agent that is not installed" sit side by side in this row
   * and must not converge.
   */
  idle: { opacity: 0.7 },
  disabled: { opacity: 0.4 },
  body: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    height: theme.size.chip,
    paddingHorizontal: theme.space(4),
  },
  label: {
    fontSize: theme.font.small,
    // The name is the pill's only content, so it carries the weight the orb
    // beside it used to share.
    fontWeight: "700",
    lineHeight: theme.font.small + 4,
    maxWidth: 160,
  },
});

/**
 * The drawer re-renders whenever any conversation changes, and none of that
 * touches a chip. Compared on the fields that actually draw.
 */
export const AgentChip = memo(
  AgentChipView,
  (before, after) =>
    before.selected === after.selected &&
    before.provider.id === after.provider.id &&
    before.provider.name === after.provider.name &&
    before.provider.color === after.provider.color &&
    before.provider.available === after.provider.available &&
    before.onPress === after.onPress,
);
