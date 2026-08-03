/**
 * The one bottom sheet every modal in this app is made of.
 *
 * Commands, an agent's thinking, and an approval request are all "a titled card
 * arriving from the bottom edge", so they share this chrome exactly: same
 * travel, same spring, same grabber, same header, same card height. Three
 * hand-rolled copies would drift the moment one of them was tuned.
 *
 * `onClose` is optional on purpose. A sheet the user opened is dismissed by the
 * scrim or the close button; an approval request is *not* — the agent is
 * blocked on an answer, and a stray tap that dismissed it would strand the turn
 * with no way back.
 *
 * A sheet with steps changes its own title and swaps close for back as it goes.
 * Both cross-fade, because the content underneath them is travelling: a header
 * that cuts while the panes slide is the one part of the movement that gives
 * away there were two cards all along.
 */
import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { Animated, Pressable, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { CircleButton } from "./controls";
import { useReducedMotion } from "./useReducedMotion";

/** Rows visible in a list sheet before it scrolls. */
export const SHEET_VISIBLE_ROWS = 5;
export const SHEET_ROW_HEIGHT = 60;
/** The card's height when a sheet is full: five rows. */
export const SHEET_CARD_HEIGHT = SHEET_VISIBLE_ROWS * SHEET_ROW_HEIGHT;

interface SheetProps {
  visible: boolean;
  title: string;
  /** Omitted for a blocking sheet: no close button, and the scrim is inert. */
  onClose?: () => void;
  /**
   * Turns the header's close button into a back button, for a sheet that has a
   * second step. Dismissal stays available on the scrim, which is how a pushed
   * screen behaves everywhere else on the platform — two buttons in a header
   * this size would crowd the title off centre.
   */
  onBack?: () => void;
  /** Accessible name for the scrim and close button. */
  dismissLabel?: string;
  children: ReactNode;
}

function SheetView({ visible, title, onClose, onBack, dismissLabel, children }: SheetProps) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  const progress = useRef(new Animated.Value(0)).current;
  const [height, setHeight] = useState(0);
  // Kept mounted while animating out, then removed: an always-mounted overlay
  // would swallow every touch meant for the conversation behind it. Declared
  // with the other hooks, above any early return.
  const mounted = useMountedWhileVisible(visible, progress);

  useEffect(() => {
    if (reduceMotion) {
      progress.setValue(visible ? 1 : 0);
      return;
    }
    // A spring, not a duration. A sheet is a physical object arriving under the
    // thumb, and a fixed curve reads as a slide being played at you — the
    // travel is long enough here that the difference is the whole feel.
    // Critically damped: it settles without a bounce, which on a list of
    // commands would look like a toy rather than a control.
    const animation = Animated.spring(progress, {
      toValue: visible ? 1 : 0,
      damping: 26,
      stiffness: 260,
      mass: 0.9,
      // The interpolations below are pixel offsets, so the default thresholds
      // (tuned for unit-scale values) would settle a couple of points short.
      restDisplacementThreshold: 0.001,
      restSpeedThreshold: 0.01,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [visible, reduceMotion, progress]);

  if (!mounted) return null;

  return (
    <View style={styles.host}>
      {/* Tapping away is the primary dismissal, so the scrim is a control —
          except on a blocking sheet, where it is only a dimming layer that
          still absorbs touches meant for the conversation. */}
      {onClose ? (
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel={dismissLabel ?? `Dismiss ${title}`}
          onPress={onClose}
        >
          <Animated.View style={[styles.scrim, { opacity: progress }]} />
        </Pressable>
      ) : (
        <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, { opacity: progress }]} />
      )}

      <Animated.View
        // Measured rather than estimated: the travel must be the sheet's real
        // height, or it starts partly on screen and appears to jump.
        onLayout={(event) => setHeight(event.nativeEvent.layout.height)}
        style={[
          styles.sheet,
          // The home indicator's clearance is inside the sheet, not under it, so
          // the content clears the indicator while the surface still reaches the
          // physical edge.
          { paddingBottom: insets.bottom + theme.space(3) },
          {
            transform: [
              {
                translateY: progress.interpolate({
                  inputRange: [0, 1],
                  // Exactly its own height, since it rests flush on the edge.
                  // Falls back to a generous estimate for the first frame,
                  // before `onLayout` has reported.
                  outputRange: [height || SHEET_CARD_HEIGHT + theme.size.touch * 4, 0],
                }),
              },
            ],
          },
        ]}
      >
        {/* Affordance only: this sheet is dismissed by the close button or the
            scrim, so the grabber is not itself draggable. */}
        <View style={styles.grabber} />

        <View style={styles.header}>
          {/* Keyed, and that is what makes the fade happen at all: both branches
              render a CircleButton at the same position, so without distinct
              keys React reconciles one instance, the icon never remounts, and
              the swap hard-cuts. */}
          {onBack ? (
            <CircleButton key="back" label="Back" onPress={onBack} size={theme.size.chip}>
              <CrossfadeIcon name="chevron-back" />
            </CircleButton>
          ) : onClose ? (
            <CircleButton
              key="close"
              label={dismissLabel ?? `Close ${title}`}
              onPress={onClose}
              size={theme.size.chip}
            >
              <CrossfadeIcon name="close" />
            </CircleButton>
          ) : (
            <View style={styles.headerSpacer} />
          )}
          <CrossfadeTitle title={title} />
          {/* Balances the close button so the title stays optically centred. */}
          <View style={styles.headerSpacer} />
        </View>

        {children}
      </Animated.View>
    </View>
  );
}

/**
 * The title, re-fading whenever the words change.
 *
 * Out then in, rather than two copies dissolving into each other: a title is
 * centred, so two of different widths overlapping mid-fade read as a smear. The
 * swap happens at zero opacity, and the pane travelling underneath is what
 * carries the sense of direction.
 */
function CrossfadeTitle({ title }: { title: string }) {
  const reduceMotion = useReducedMotion();
  const shown = useRef(title);
  const fade = useRef(new Animated.Value(1)).current;
  const [rendered, setRendered] = useState(title);

  useEffect(() => {
    if (title === shown.current) return;
    shown.current = title;
    if (reduceMotion) {
      setRendered(title);
      return;
    }
    const animation = Animated.timing(fade, {
      toValue: 0,
      duration: 110,
      useNativeDriver: true,
    });
    animation.start(({ finished }) => {
      // A second change interrupts the first: `stop()` reports unfinished, and
      // the newer effect owns the swap. Without this guard the stale title
      // would be committed on top of it.
      if (!finished) return;
      setRendered(title);
      Animated.timing(fade, { toValue: 1, duration: 150, useNativeDriver: true }).start();
    });
    return () => animation.stop();
  }, [title, reduceMotion, fade]);

  return (
    <Animated.Text style={[styles.title, { opacity: fade }]} numberOfLines={1}>
      {rendered}
    </Animated.Text>
  );
}

/**
 * The header glyph, fading in when it is swapped for a different one.
 *
 * Remounted by the keys on the buttons above, so this only ever plays the
 * arrival — the half that matters when close becomes back.
 */
function CrossfadeIcon({ name }: { name: keyof typeof Ionicons.glyphMap }) {
  const reduceMotion = useReducedMotion();
  const fade = useRef(new Animated.Value(reduceMotion ? 1 : 0)).current;

  useEffect(() => {
    if (reduceMotion) {
      fade.setValue(1);
      return;
    }
    const animation = Animated.timing(fade, {
      toValue: 1,
      duration: 160,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [reduceMotion, fade]);

  return (
    <Animated.View style={{ opacity: fade }}>
      <Ionicons name={name} size={18} color={theme.color.text} />
    </Animated.View>
  );
}

/**
 * Mounted for as long as the sheet is on screen, including its exit.
 *
 * Unmounting on `visible === false` would cut the close animation; staying
 * mounted forever would put an invisible scrim over the conversation.
 */
function useMountedWhileVisible(visible: boolean, progress: Animated.Value) {
  const [mounted, setMounted] = useState(visible);

  useEffect(() => {
    if (visible) {
      setMounted(true);
      return;
    }
    const id = progress.addListener(({ value }) => {
      if (value === 0) setMounted(false);
    });
    return () => progress.removeListener(id);
  }, [visible, progress]);

  return mounted;
}

const styles = StyleSheet.create({
  host: { ...StyleSheet.absoluteFillObject, zIndex: 20, justifyContent: "flex-end" },
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.55)" },
  // Inset left and right so the thread stays visible down both sides, but sat
  // on the bottom edge: a sheet rises *from* the screen edge, and a gap under
  // it would leave the home indicator stranded on the conversation behind.
  // Square where it meets that edge, for the same reason — rounding a corner
  // there implies a boundary the sheet does not actually have.
  sheet: {
    marginHorizontal: theme.gutter,
    backgroundColor: theme.color.surface,
    borderTopLeftRadius: theme.radius.pane,
    borderTopRightRadius: theme.radius.pane,
    paddingHorizontal: theme.space(3),
  },
  grabber: {
    alignSelf: "center",
    width: 36,
    height: 4,
    borderRadius: 2,
    backgroundColor: theme.color.textFaint,
    marginTop: theme.space(2),
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: theme.space(3),
  },
  headerSpacer: { width: theme.size.chip },
  title: {
    color: theme.color.text,
    fontSize: theme.font.title,
    fontWeight: "600",
  },
});

/** The card the sheet's content sits in: one rounded, clipped raised surface. */
export const sheetCardStyle = {
  backgroundColor: theme.color.surfaceRaised,
  borderRadius: theme.radius.lg,
  overflow: "hidden",
} as const;

export const Sheet = memo(SheetView);
