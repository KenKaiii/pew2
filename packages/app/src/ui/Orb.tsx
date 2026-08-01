/**
 * The agent mark.
 *
 * One sphere is the app's memorable device: it stands in for "an agent is
 * here", takes the provider's own colour so Claude, Codex and Gemini are
 * distinguishable at a glance, and is the only saturated thing on an otherwise
 * monochrome canvas.
 *
 * It is drawn as a dot-matrix panel because the wordmark beside it is set in
 * Bitcount, a single-module dot-matrix face — the logotype is already an LED
 * grid, so the mark is built from the same cells rather than being a gradient
 * disc with nothing in common with the type. It also says what the product is:
 * a readout of a machine you are not sitting at.
 *
 * Shading is dot area and opacity, never a gradient, because that is the only
 * way a real matrix panel can render a tone. `orbMatrix.ts` owns that geometry.
 */
import { memo, useEffect, useMemo, useRef } from "react";
import { Animated, Easing, StyleSheet, View } from "react-native";
import { theme, shade } from "../theme";
import { useReducedMotion } from "./useReducedMotion";
import {
  gridForSize,
  MATRIX_MIN_SIZE,
  orbLoop,
  sweepAt,
  type DotTrack,
} from "./orbMatrix";

interface OrbProps {
  color?: string;
  size?: number;
  /** Sweeps while the agent is working. Honest signal, not decoration. */
  busy?: boolean;
}

/**
 * One full orbit of the key light.
 *
 * Slow enough to read as a lit object rather than a spinner, but fast enough to
 * actually be seen: an average dot swings about 0.46 in opacity across the
 * orbit, so at eight seconds it changes roughly 0.12 a second — gentle, and
 * above the threshold where the eye registers motion at all. An earlier
 * eighteen-second loop was arithmetically correct and looked completely static.
 */
const DRIFT_DURATION = 8000;

/**
 * Steps the orbit is sampled at.
 *
 * The driver interpolates between them, so this is resolution, not frame rate:
 * 32 puts a step every 11 degrees, below the point where the terminator's
 * travel reads as stepped.
 */
const DRIFT_STEPS = 32;

/** One pass of the scan. Slow enough to read as deliberate, not as a spinner. */
const SWEEP_DURATION = 2200;

/** Steps the sweep is sampled at. Enough to look continuous, cheap to build. */
const SWEEP_STEPS = 24;

/**
 * How far a column falls behind the scan band.
 *
 * The band brightens by dimming everything else, because opacity cannot exceed
 * one and a wrapper can only ever take light away. That is also the truer
 * picture: on a scanned panel the cells the beam has left are decaying.
 */
const DECAY = 0.72;

function OrbView({ color, size = theme.size.orb, busy = false }: OrbProps) {
  const base = color ?? theme.color.orb;
  const reduceMotion = useReducedMotion();
  const matrix = size >= MATRIX_MIN_SIZE;

  return (
    // Purely decorative, and it sits inside tappable chips, so it must never
    // intercept a touch meant for the row behind it.
    <View style={{ width: size, height: size }} pointerEvents="none">
      {matrix ? (
        <Matrix base={base} size={size} busy={busy} reduceMotion={reduceMotion} />
      ) : (
        <Silhouette base={base} size={size} />
      )}
    </View>
  );
}

/**
 * The mark below `MATRIX_MIN_SIZE`.
 *
 * At chip size the cells are smaller than the dot they would contain and the
 * grid reads as mud, so it collapses to the shape the matrix describes, lit
 * from the same corner: two views instead of forty, which matters in a list.
 */
function Silhouette({ base, size }: { base: string; size: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: base,
      }}
    >
      <View
        style={[
          styles.silhouetteLight,
          {
            width: size * 0.5,
            height: size * 0.5,
            borderRadius: size * 0.25,
            top: size * 0.1,
            left: size * 0.14,
            backgroundColor: shade(base, 0.5),
          },
        ]}
      />
    </View>
  );
}

function Matrix({
  base,
  size,
  busy,
  reduceMotion,
}: {
  base: string;
  size: number;
  busy: boolean;
  reduceMotion: boolean;
}) {
  const grid = gridForSize(size);
  const pitch = size / grid;
  const drift = useRef(new Animated.Value(0)).current;
  const sweep = useRef(new Animated.Value(0)).current;

  // The whole orbit, precomputed once per grid: relighting a sphere is real
  // arithmetic, and doing it per frame would put it on the JS thread behind a
  // streaming transcript. Colour is applied separately, so one loop serves
  // every provider.
  const tracks = useMemo(() => orbLoop(grid, DRIFT_STEPS), [grid]);
  const steps = useMemo(
    () =>
      Array.from({ length: DRIFT_STEPS + 1 }, (_, step) => step / DRIFT_STEPS),
    [],
  );

  useEffect(() => {
    if (reduceMotion) {
      drift.stopAnimation();
      drift.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(drift, {
        toValue: 1,
        duration: DRIFT_DURATION,
        // Linear: an orbit has no start or finish. Any easing would show up as
        // the light pausing at the same point on every pass.
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [reduceMotion, drift]);

  useEffect(() => {
    if (!busy || reduceMotion) {
      sweep.stopAnimation();
      sweep.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(sweep, {
        toValue: 1,
        duration: SWEEP_DURATION,
        // Linear: a scan travels at a constant rate. Easing would read as the
        // band hesitating in the middle of the panel.
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => loop.stop();
  }, [busy, reduceMotion, sweep]);

  const scanning = busy && !reduceMotion;

  // One node per column carries the scan, so the band costs thirteen animated
  // values rather than one per dot.
  const scan = useMemo(() => {
    if (!scanning) return null;
    const inputRange = Array.from(
      { length: SWEEP_STEPS + 1 },
      (_, step) => step / SWEEP_STEPS,
    );
    return Array.from({ length: grid }, (_, column) =>
      sweep.interpolate({
        inputRange,
        outputRange: inputRange.map(
          (progress) => DECAY + (1 - DECAY) * sweepAt(progress, column, grid),
        ),
      }),
    );
  }, [scanning, grid, sweep]);

  return (
    <View style={styles.panel}>
      {tracks.map((track, index) => (
        <Cell
          key={index}
          track={track}
          pitch={pitch}
          base={base}
          drift={reduceMotion ? null : drift}
          steps={steps}
          // Column opacity multiplies the dot's own, so the scan shades the
          // panel without disturbing the shading underneath it.
          scan={scan?.[track.column]}
        />
      ))}
    </View>
  );
}

function Cell({
  track,
  pitch,
  base,
  drift,
  steps,
  scan,
}: {
  track: DotTrack;
  pitch: number;
  base: string;
  drift: Animated.Value | null;
  steps: number[];
  scan?: Animated.AnimatedInterpolation<number>;
}) {
  // Gaps between cells are what make a panel read as pixels rather than as a
  // solid disc, so the dot never fills its whole cell. Laid out at its largest
  // and scaled down from there, because width cannot be driven natively but a
  // transform can.
  const diameter = pitch * 0.86;

  const scale = drift
    ? drift.interpolate({ inputRange: steps, outputRange: track.fill })
    : track.fill[0]!;
  const lit = drift
    ? drift.interpolate({ inputRange: steps, outputRange: track.opacity })
    : track.opacity[0]!;
  // Travel is in pitch units so the geometry stays resolution-free; it becomes
  // points only here, where the cell size is known.
  const translateX = drift
    ? drift.interpolate({
        inputRange: steps,
        outputRange: track.dx.map((value) => value * pitch),
      })
    : track.dx[0]! * pitch;
  const translateY = drift
    ? drift.interpolate({
        inputRange: steps,
        outputRange: track.dy.map((value) => value * pitch),
      })
    : track.dy[0]! * pitch;

  return (
    <Animated.View
      style={{
        position: "absolute",
        left: track.cx * pitch - diameter / 2,
        top: track.cy * pitch - diameter / 2,
        width: diameter,
        height: diameter,
        borderRadius: diameter / 2,
        backgroundColor: base,
        opacity: scan ? Animated.multiply(lit, scan) : lit,
        // Translate before scale: scaling first would shrink the offset too, so
        // a dim dot would travel less far than a lit one at the same latitude.
        transform: [{ translateX }, { translateY }, { scale }],
      }}
    >
      {/* Gloss as its own layer, because a colour cannot be driven natively.
          Only on dots the highlight actually reaches, so the whole panel does
          not carry a second view for an effect it never shows. Mixed toward
          white rather than replaced by it, so gloss never costs the provider
          its colour — an agent must stay identifiable at a glance. */}
      {track.peakSpecular > 0.02 && (
        <Animated.View
          style={{
            ...StyleSheet.absoluteFillObject,
            borderRadius: diameter / 2,
            backgroundColor: shade(base, 0.62),
            opacity: drift
              ? drift.interpolate({
                  inputRange: steps,
                  outputRange: track.specular,
                })
              : track.specular[0]!,
          }}
        />
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1 },
  silhouetteLight: { position: "absolute", opacity: 0.9 },
});

// The mark re-renders only when its provider, size or working state changes —
// not on every streamed chunk of the conversation behind it.
export const Orb = memo(OrbView);
