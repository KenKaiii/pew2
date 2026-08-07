/**
 * The one bottom sheet every modal in this app is made of.
 *
 * Commands, an agent's thinking, and an approval request are all "a titled card
 * arriving from the bottom edge", so they share this chrome exactly: same
 * travel, same spring, same grabber, same header, same card height. Three
 * hand-rolled copies would drift the moment one of them was tuned.
 *
 * `onClose` is optional on purpose. A sheet the user opened is dismissed by the
 * scrim, the grabber, or the close button; an approval request is *not* — the
 * agent is blocked on an answer, and a stray tap that dismissed it would strand
 * the turn with no way back.
 *
 * A sheet with steps changes its own title and swaps close for back as it goes.
 * Both cross-fade, because the content underneath them is travelling: a header
 * that cuts while the panes slide is the one part of the movement that gives
 * away there were two cards all along.
 *
 * ## Why every value here lives on the UI thread
 *
 * This used to be legacy `Animated` with the travel distance held in React
 * state. Opening cost three commits of the whole app tree before a single pixel
 * moved — render to mount, render to measure, render to animate — and that dead
 * air between the finger leaving the glass and the card starting to move is
 * exactly what read as "not smooth". UIKit starts a sheet's transition on the
 * same frame as the touch.
 *
 * So: one commit, and everything after it is Reanimated. The card is present in
 * the same render that flips `visible`, its measured height goes into a shared
 * value rather than state (no re-render), and the spring runs on the UI thread
 * where React cannot starve it. What is left is a single layout pass — which is
 * what the platform spends too.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Dimensions, Keyboard, Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  FadeIn,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { CircleButton } from "./controls";
import { haptics } from "./haptics";
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

/**
 * How far down the card has to be dragged before letting go dismisses it,
 * as a fraction of its own height. A quarter is the platform's own feel: far
 * enough that a scroll that leaks into a drag does not close anything, close
 * enough that a deliberate flick never has to travel the whole card.
 */
const DISMISS_FRACTION = 0.25;
/** …or this fast, in card-heights per second, however far it actually got. */
const DISMISS_VELOCITY = 2.2;

/**
 * The arrival.
 *
 * Underdamped on purpose. A critically damped spring cannot overshoot, but the
 * price is a long imperceptible creep into the final few points — the card looks
 * parked while the scrim is still darkening, which is the "mushy" feel this
 * replaced. `dampingRatio` 0.85 is what UIKit's own sheet transitions use: it
 * arrives, tightens once by well under a point, and is *done*.
 *
 * `duration` here is perceptual, not literal — Reanimated runs the spring for
 * about 1.5× the number, so 420 is a ~630ms tail with the last third of it
 * invisible.
 */
const ARRIVE = { duration: 420, dampingRatio: 0.85 } as const;
/**
 * The departure, and deliberately not a spring.
 *
 * A sheet leaving has nowhere to settle — it is gone the moment it clears the
 * edge — so spring physics buy nothing and cost the tail. Fast, decelerating,
 * and ~40% shorter than the arrival, which is the asymmetry every platform
 * uses: you wait for things to arrive, you never wait for them to leave.
 */
const DEPART = { duration: 240, easing: Easing.out(Easing.cubic) } as const;
/** Spring back after a drag that did not go far enough to dismiss. */
const RETURN = { duration: 320, dampingRatio: 0.9 } as const;
/**
 * Reduced motion: the same movement with the time taken out.
 *
 * A zero-duration timing rather than a bare assignment, because the unmount
 * hangs off the closing animation's completion callback. Assigning a plain
 * number skips the animation machinery, and with it the callback — which would
 * leave the sheet mounted forever for exactly the users who cannot see it.
 */
const INSTANT = { duration: 0 } as const;

/**
 * Where the card sits before it has ever been measured.
 *
 * Only ever used for the first frame of the first open, and only as a distance
 * to start *from* — so an overestimate is invisible (the card is off screen
 * either way) and there is no underestimate that could leave it peeking.
 */
const OFF_SCREEN = Dimensions.get("window").height;

function SheetView({ visible, title, onClose, onBack, dismissLabel, children }: SheetProps) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();

  // Present in the tree, which outlasts `visible` by exactly one closing
  // animation: an always-mounted overlay would swallow every touch meant for
  // the conversation behind it.
  //
  // Raised *during render* rather than from an effect. An effect would cost a
  // second commit of the whole app tree before the card existed at all, and
  // that commit is the latency being removed here — this way the tap and the
  // first frame of movement land together, the way they do on the platform.
  const [present, setPresent] = useState(visible);
  if (visible && !present) setPresent(true);

  /**
   * How far in the card is: 0 is fully off the bottom edge, 1 is resting.
   *
   * One value for the whole movement, arriving and leaving and dragged, so
   * every one of those can interrupt any other by simply being retargeted —
   * which is what makes a sheet feel like an object rather than a clip being
   * played at you.
   *
   * Deliberately *not* a layout animation on `originY`, which is what this used
   * to be. A layout animation resolves its destination from the measurement
   * taken when it starts, and these sheets contain a card that measures itself
   * a frame later — so the first open of a sheet whose content had never been
   * laid out animated to a position derived from a 1pt-tall card and stopped
   * short. Every later open looked right because the measurement was by then
   * left over from the first. A transform to zero has no such dependency: zero
   * means "wherever layout puts you", which stays true however the card resizes
   * around it.
   */
  const progress = useSharedValue(0);

  // The card's own height, so a drag is judged against the thing being dragged
  // rather than against the screen. Written from `onLayout`, read only on the
  // UI thread; nothing here re-renders.
  const travel = useSharedValue(0);

  useEffect(() => {
    if (!visible) return;
    // A sheet rests against the bottom edge, which is exactly where the keyboard
    // is. Opening one from the composer put the whole card behind it — invisible,
    // and its rows unreachable. Every sheet in this app is a list or a set of
    // buttons, none of them holds a text field, so there is never a reason for
    // the keyboard to stay up over one.
    Keyboard.dismiss();
  }, [visible]);

  // Removed only once the card has actually left. Guarded against a sheet
  // reopened mid-exit: the callback for the old animation still arrives, and
  // unmounting on it would delete a card that is on its way back in.
  const finishExit = useCallback(() => {
    setPresent((wasPresent) => (visible ? wasPresent : false));
  }, [visible]);

  useEffect(() => {
    if (visible) {
      progress.value = reduceMotion
        ? withTiming(1, INSTANT)
        : withSpring(1, ARRIVE);
      return;
    }
    progress.value = withTiming(0, reduceMotion ? INSTANT : DEPART, (finished) => {
      "worklet";
      // Interrupted means it was reopened on the way out, and the newer
      // animation owns what happens next.
      if (finished) runOnJS(finishExit)();
    });
  }, [visible, reduceMotion, progress, finishExit]);

  const dismiss = onClose;
  // The card follows the finger one-to-one downward and refuses to go up: a
  // sheet already flush against the bottom edge has nothing above it to reveal,
  // and letting it lift would show daylight underneath.
  //
  // Expressed as a change in `progress` rather than as its own offset, so a
  // release can hand straight over to the spring, and so the scrim thins with
  // the drag for free.
  const dragGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(dismiss !== undefined && !reduceMotion)
        .onChange((event) => {
          const height = travel.value;
          if (height <= 0) return;
          progress.value = Math.min(1, progress.value - event.changeY / height);
        })
        .onEnd((event) => {
          const height = travel.value;
          const thrown = height > 0 ? event.velocityY / height : 0;
          if (progress.value < 1 - DISMISS_FRACTION || thrown > DISMISS_VELOCITY) {
            // Left exactly where the finger let go: the closing animation picks
            // `progress` up from here, so the card never snaps back up a single
            // point before leaving.
            runOnJS(haptics.tap)();
            if (dismiss) runOnJS(dismiss)();
            return;
          }
          progress.value = withSpring(1, RETURN);
        }),
    [dismiss, reduceMotion, progress, travel],
  );

  const cardStyle = useAnimatedStyle(() => ({
    // Falls back to a whole screen only until the first measurement lands, and
    // only as a starting distance — the resting end of this is always exactly
    // zero, which is why a card that resizes after arriving still ends flush.
    transform: [{ translateY: (1 - progress.value) * (travel.value || OFF_SCREEN) }],
  }));

  // The scrim tracks the same value, so dragging the card away brings the
  // conversation back under the thumb. Squared off early: it reaches full
  // darkness at 70% of the travel, because a scrim still visibly dark at the
  // point of release makes the dismissal read as reluctant.
  const scrimStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 0.7], [0, 1], "clamp"),
  }));

  if (!present) return null;

  return (
    // Inert while leaving: the card is still on screen for the length of its
    // exit, and a scrim that kept taking touches for that quarter second would
    // eat the first tap of whatever the user turned to next.
    <View style={styles.host} pointerEvents={visible ? "box-none" : "none"}>
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
          <Animated.View style={[styles.scrim, scrimStyle]} />
        </Pressable>
      ) : (
        <Animated.View style={[StyleSheet.absoluteFill, styles.scrim, scrimStyle]} />
      )}

      <Animated.View
        onLayout={(event) => {
          travel.value = event.nativeEvent.layout.height;
        }}
        style={[
          styles.sheet,
          // The home indicator's clearance is inside the sheet, not under it,
          // so the content clears the indicator while the surface still
          // reaches the physical edge.
          { paddingBottom: insets.bottom + theme.space(3) },
          cardStyle,
        ]}
      >
        {/* Dragging is bound to the header strip rather than the whole card:
            every sheet's body is a scrolling list, and a pan over one would have
            to win a fight against the scroll on every gesture. The grabber sits
            inside it, so the affordance is where the gesture actually is. */}
        <GestureDetector gesture={dragGesture}>
          {/* Not collapsable: React Native flattens a View that adds no styling
              of its own, and gesture-handler needs a real native view to attach
              to. */}
          <View collapsable={false}>
            <View style={styles.grabber} />

            <View style={styles.header}>
              {/* Keyed, and that is what makes the fade happen at all: both
                  branches render a CircleButton at the same position, so without
                  distinct keys React reconciles one instance, the icon never
                  remounts, and the swap hard-cuts. */}
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
              {/* Balances the close button so the title stays optically
                  centred. */}
              <View style={styles.headerSpacer} />
            </View>
          </View>
        </GestureDetector>

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
  const fade = useSharedValue(1);
  const [rendered, setRendered] = useState(title);

  useEffect(() => {
    if (title === shown.current) return;
    shown.current = title;
    if (reduceMotion) {
      setRendered(title);
      return;
    }
    // The swap happens inside the animation's own completion, on the UI thread,
    // so the words change at exactly zero opacity rather than on whichever
    // frame a JS timer happened to land on.
    fade.value = withTiming(0, { duration: 110 }, (finished) => {
      "worklet";
      // A second change interrupts the first: an interrupted timing reports
      // unfinished, and the newer effect owns the swap. Without this guard the
      // stale title would be committed on top of it.
      if (!finished) return;
      runOnJS(setRendered)(title);
      fade.value = withTiming(1, { duration: 150 });
    });
  }, [title, reduceMotion, fade]);

  const style = useAnimatedStyle(() => ({ opacity: fade.value }));

  return (
    <Animated.Text style={[styles.title, style]} numberOfLines={1}>
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
  return (
    <Animated.View entering={FadeIn.duration(160)}>
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
