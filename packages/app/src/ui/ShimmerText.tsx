/**
 * Text lit by a gradient travelling across the glyphs.
 *
 * A gradient cannot be a text style, so the text is used as a *mask* and the
 * colour is painted underneath: a solid base for what the word is at rest, and
 * a moving highlight that lifts it as it passes. Masking means only the glyphs
 * are lit — a gradient laid over the row would light the gaps between letters
 * and read as a bar sliding past.
 *
 * Two users, two rhythms. The composer's `/command` pulses (a sweep, then a
 * pause) because it is punctuation on a static badge; the activity line sweeps
 * continuously because it is the app's proof that something is still happening
 * on a machine the user cannot see.
 */
import { memo, useEffect, useRef, useState } from "react";
import { Animated, StyleSheet, Text, View, type TextStyle } from "react-native";
import MaskedView from "@react-native-masked-view/masked-view";
import { LinearGradient } from "expo-linear-gradient";
import { theme } from "../theme";
import { useReducedMotion } from "./useReducedMotion";
import { useAppActive } from "./useAppActive";

/**
 * Highlight that fades in and out of the base colour rather than replacing it.
 *
 * Transparent at both ends so the sheen has no edges — a hard stop would read
 * as a stripe — and white at the core, which lifts the base toward its own tint
 * instead of greying it.
 */
const SHEEN_COLORS = [
  "rgba(255,255,255,0)",
  "rgba(255,255,255,0.1)",
  "rgba(255,255,255,0.85)",
  "rgba(255,255,255,0.1)",
  "rgba(255,255,255,0)",
] as const satisfies readonly [string, string, ...string[]];

/**
 * Sheen width as a multiple of the text's. Wider than the word so the bright
 * core crosses it in one pass rather than reading as a passing stripe.
 */
const SHEEN_SCALE = 1.6;

export type ShimmerTextProps = {
  text: string;
  /** The colour at rest, and the whole appearance under reduced motion. */
  color?: string;
  size?: number;
  lineHeight?: number;
  weight?: TextStyle["fontWeight"];
  /** One pass of the sheen, in ms. */
  duration?: number;
  /** Pause between passes. Zero makes it continuous. */
  gap?: number;
  /** Long tool titles must not wrap the transcript's footer to two lines. */
  numberOfLines?: number;
};

function ShimmerTextView({
  text,
  color = theme.color.textDim,
  size = theme.font.body,
  lineHeight = theme.line.body,
  weight = "500",
  duration = 1800,
  gap = 0,
  numberOfLines,
}: ShimmerTextProps) {
  const sweep = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReducedMotion();
  const appActive = useAppActive();
  const [width, setWidth] = useState(0);

  // Paused while backgrounded. This runs for as long as the agent is thinking,
  // which is exactly when someone is most likely to have switched away.
  useEffect(() => {
    if (reduceMotion || !appActive || width === 0) return;
    const pass = Animated.timing(sweep, {
      toValue: 1,
      duration,
      useNativeDriver: true,
    });
    const loop = Animated.loop(
      // The pause happens with the sheen parked off the right edge, so the
      // reset back to the left is never visible.
      gap > 0 ? Animated.sequence([pass, Animated.delay(gap)]) : pass,
      // Resets to 0 between iterations, which is off-text in both directions.
      { resetBeforeIteration: true },
    );
    loop.start();
    return () => loop.stop();
  }, [duration, gap, reduceMotion, appActive, sweep, width]);

  // The mask only reads alpha, so this colour matters solely where a platform
  // has no mask (web): there the text is drawn directly, and naming the resting
  // colour keeps it dim instead of full white.
  const label: TextStyle = { fontSize: size, lineHeight, fontWeight: weight, color };
  const sheenWidth = width * SHEEN_SCALE;

  return (
    <MaskedView
      style={styles.host}
      // The text is the mask, so the gradient below paints only the glyphs.
      maskElement={
        <Text style={label} numberOfLines={numberOfLines}>
          {text}
        </Text>
      }
    >
      {/* Sets the size everything else is measured against, and carries the
          resting colour. */}
      <View
        style={{ backgroundColor: color }}
        // Rounded, and only when it actually moved. This row sits in the
        // transcript's footer, whose padding is re-measured on every frame of
        // the keyboard animation — so an unguarded `setWidth` would re-render
        // the mask on sub-pixel noise for the length of that animation.
        onLayout={(event) => {
          const next = Math.round(event.nativeEvent.layout.width);
          setWidth((current) => (current === next ? current : next));
        }}
      >
        <Text style={[label, styles.invisible]} numberOfLines={numberOfLines}>
          {text}
        </Text>
      </View>

      {!reduceMotion && width > 0 && (
        // The transform rides a plain Animated.View, never the gradient itself:
        // `LinearGradient` is a class component that does not forward a ref to
        // its native view, so the native driver has no node to drive and the
        // animation silently does nothing.
        //
        // Explicitly sized and pinned to the left edge only. Anchoring both
        // edges would over-constrain it, leaving a layer already the width of
        // the text with nowhere to travel.
        <Animated.View
          style={[
            styles.sheen,
            {
              width: sheenWidth,
              transform: [
                {
                  // Fully clear of the text at both ends, so it enters and
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
  // Occupies the mask's exact space while contributing no colour of its own.
  invisible: { opacity: 0 },
  sheen: { position: "absolute", top: 0, bottom: 0, left: 0 },
});

export const ShimmerText = memo(ShimmerTextView);
