/**
 * The `/command` at the head of a draft, lit by a travelling sheen.
 *
 * A command is not ordinary prose — it is the one word in the box that changes
 * what the agent will do — so it is set in the accent colour and weighted to say
 * so. The sheen marks it as *live*: the app recognised the token and will act on
 * it, as opposed to text that merely begins with a slash.
 *
 * Drawn as an overlay above the composer rather than inside it, because a
 * gradient cannot be a text style. The token the `TextInput` holds is rendered
 * transparent and this sits exactly on top; the two agree because a command is
 * always at offset zero and both use the same font metrics.
 */
import { memo, useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View } from "react-native";
import MaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import { theme } from "../theme";
import { useReducedMotion } from "./useReducedMotion";

/** One pass of the sheen. Unhurried, so it reads as a sheen and not a flicker. */
const SWEEP_DURATION = 1800;

/** Pause between passes, so it is punctuation rather than a loading bar. */
const SWEEP_GAP = 900;

/**
 * Sheen width, as a multiple of the token's. Wider than the word so the bright
 * core crosses it as one pass rather than reading as a passing stripe.
 */
const SHEEN_SCALE = 1.6;

/**
 * A highlight that fades in and out of the accent rather than replacing it.
 *
 * Transparent at both ends so the sheen has no edges — a hard stop would read as
 * a bar sliding over the text — and white at the core, which lifts the accent
 * toward its own tint instead of greying it.
 */
const SHEEN_COLORS = [
  "rgba(255,255,255,0)",
  "rgba(255,255,255,0.1)",
  "rgba(255,255,255,0.85)",
  "rgba(255,255,255,0.1)",
  "rgba(255,255,255,0)",
] as const satisfies readonly [string, string, ...string[]];

function CommandTokenView({
  text,
  size = theme.font.body,
  lineHeight = theme.line.body,
}: {
  text: string;
  /** Defaults to body text; the composer badge sets its own, smaller scale. */
  size?: number;
  lineHeight?: number;
}) {
  const sweep = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReducedMotion();
  const [width, setWidth] = useState(0);

  useEffect(() => {
    if (reduceMotion || width === 0) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(sweep, {
          toValue: 1,
          duration: SWEEP_DURATION,
          useNativeDriver: true,
        }),
        // The gap happens with the sheen parked off the right edge, so the
        // reset back to the left is never visible.
        Animated.delay(SWEEP_GAP),
      ]),
      // Resets to 0 between iterations, which is off-token in both directions.
      { resetBeforeIteration: true },
    );
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, sweep, width]);

  const sheenWidth = width * SHEEN_SCALE;

  return (
    <MaskedView
      style={styles.host}
      // The text is the mask, so the gradient below paints only the glyphs and
      // never the gaps between them.
      maskElement={<Text style={[styles.token, { fontSize: size, lineHeight }]}>{text}</Text>}
    >
      {/* Sets the size everything else is measured against, and carries the
          resting colour: what the token is when the sheen is elsewhere, and its
          whole appearance under reduced motion. */}
      <View
        style={styles.base}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        <Text style={[styles.token, styles.invisible, { fontSize: size, lineHeight }]}>
          {text}
        </Text>
      </View>

      {!reduceMotion && width > 0 && (
        // The transform rides a plain Animated.View, never the gradient itself:
        // `LinearGradient` is a class component that does not forward a ref to
        // its native view, so the native driver has no node to drive and the
        // animation silently does nothing. Wrapping it in a core view that
        // Animated does understand is what makes the sheen actually move.
        //
        // Explicitly sized and pinned to the left edge only. Anchoring both
        // edges too would over-constrain it, leaving a layer already the width
        // of the token with nowhere to travel.
        <Animated.View
          style={[
            styles.sheen,
            {
              width: sheenWidth,
              transform: [
                {
                  // Fully clear of the token at both ends, so it enters and
                  // leaves rather than materialising over the word.
                  translateX: sweep.interpolate({
                    inputRange: [0, 1],
                    outputRange: [-sheenWidth, width],
                  }),
                },
              ],
            },
          ]}
        >
          <LinearGradient
            colors={SHEEN_COLORS}
            start={{ x: 0, y: 0.5 }}
            end={{ x: 1, y: 0.5 }}
            style={StyleSheet.absoluteFill}
          />
        </Animated.View>
      )}
    </MaskedView>
  );
}

const styles = StyleSheet.create({
  host: { flexDirection: "row" },
  base: { backgroundColor: theme.color.accent },
  // Occupies the mask's exact space while contributing no colour of its own.
  invisible: { opacity: 0 },
  sheen: { position: "absolute", top: 0, bottom: 0, left: 0 },
  token: {
    fontWeight: "700",
    color: theme.color.text,
  },
});

export const CommandToken = memo(CommandTokenView);
