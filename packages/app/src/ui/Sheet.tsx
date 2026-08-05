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
import { Animated, Pressable, StyleSheet, View } from "react-native";
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
  const [mounted, setMounted] = useState(visible);
  useEffect(() => {
    if (visible) setMounted(true);
  }, [visible]);

  // The travel distance is the sheet's own height, and that is not known until
  // it has been laid out once. Animating before then is what made the arrival
  // look broken: the spring ran against an *estimated* height, `onLayout`
  // reported the real one part-way through, and the sheet jumped by the
  // difference — mid-flight, every first open.
  //
  // A boolean rather than the height itself, so that a sheet which resizes while
  // open (a step changing panes) does not restart its entry animation.
  const measured = height > 0;

  useEffect(() => {
    if (!measured) {
      // Closed again before it was ever laid out — a double tap, or a sheet
      // dismissed by the same action that opened it. There is no animation to
      // play and none will start, so unmount now: leaving it mounted would
      // strand a full-screen scrim at zero opacity over the conversation,
      // invisible and eating every touch.
      if (!visible) setMounted(false);
      return;
    }
    if (reduceMotion) {
      progress.setValue(visible ? 1 : 0);
      if (!visible) setMounted(false);
      return;
    }
    // A spring, not a duration. A sheet is a physical object arriving under the
    // thumb, and a fixed curve reads as a slide being played at you — the
    // travel is long enough here that the difference is the whole feel.
    //
    // Critically damped, and now actually so: `2 * sqrt(stiffness * mass)` is
    // 30.6 for these values, and the 26 that used to be here left it underdamped
    // enough to overshoot ~0.6%. On a sheet that rests flush against the bottom
    // edge that overshoot is not a bounce, it is the card briefly lifting *off*
    // the screen edge and showing a couple of points of daylight underneath it
    // before settling back.
    const animation = Animated.spring(progress, {
      toValue: visible ? 1 : 0,
      damping: 31,
      stiffness: 260,
      mass: 0.9,
      // `progress` is unit-scale but drives a translation of the sheet's whole
      // height, so the defaults — which are judged against the animated value
      // itself — would call it settled while it was still several points short.
      restDisplacementThreshold: 0.001,
      restSpeedThreshold: 0.01,
      useNativeDriver: true,
    });
    // Unmounted from the animation's own completion rather than by watching the
    // value cross zero. A native-driven spring reports back to JS on its own
    // schedule, so an exact-zero reading is not guaranteed to arrive — and if it
    // never did, the sheet stayed mounted with a full-screen scrim over a
    // conversation that then could not be tapped at all.
    animation.start(({ finished }) => {
      if (finished && !visible) setMounted(false);
    });
    return () => animation.stop();
  }, [visible, measured, reduceMotion, progress]);

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
          // Hidden for the one frame between mounting and being measured.
          //
          // That frame is laid out with an *estimated* height, which put the
          // card partly on screen before the real measurement moved it back off
          // and the spring started — a visible flash-and-snap on every first
          // open. It still has to be laid out to be measured, so this hides it
          // rather than skipping it.
          { opacity: measured ? 1 : 0 },
          {
            transform: [
              {
                translateY: progress.interpolate({
                  inputRange: [0, 1],
                  // Exactly its own height, since it rests flush on the edge.
                  // Before the first layout this is a guess, but nothing is
                  // animating yet and `progress` is pinned at 0 — so the sheet
                  // simply waits off screen rather than travelling the wrong
                  // distance and correcting itself in view.
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
