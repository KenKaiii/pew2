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
import { Keyboard, Pressable, StyleSheet, View } from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  interpolate,
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type EntryAnimationsValues,
  type ExitAnimationsValues,
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
/** …or this fast, in points per second, however far it actually got. */
const DISMISS_VELOCITY = 700;

/**
 * The arrival.
 *
 * Underdamped on purpose, unlike the critically-damped spring this replaces.
 * That one could not overshoot, but the price was a long imperceptible creep
 * into the final few points — the card looked parked while the scrim was still
 * darkening, which is the "mushy" half of the old feel. `dampingRatio` 0.85 is
 * what UIKit's own sheet transitions use: it arrives, tightens once by well
 * under a point, and is *done*.
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
 * A zero-duration timing rather than a bare target value, because the sheet's
 * unmount hangs off the exit animation's completion callback. Assigning a plain
 * number skips the animation machinery, and with it the callback — which would
 * leave the sheet mounted forever for exactly the users who cannot see it.
 */
const INSTANT = { duration: 0 } as const;

function SheetView({ visible, title, onClose, onBack, dismissLabel, children }: SheetProps) {
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();

  // Present in the tree, which outlasts `visible` by exactly one exit animation:
  // an always-mounted overlay would swallow every touch meant for the
  // conversation behind it.
  //
  // Raised *during render* rather than from an effect. An effect would cost a
  // second commit of the whole app tree before the card existed at all, and
  // that commit is the latency being removed here — this way the tap and the
  // first frame of movement land together, the way they do on the platform.
  const [present, setPresent] = useState(visible);
  if (visible && !present) setPresent(true);

  // How far the finger has dragged the card down from its resting position.
  // Lives on the UI thread and is never read by React, so a drag re-renders
  // nothing at all.
  const drag = useSharedValue(0);

  useEffect(() => {
    if (!visible) return;
    // A sheet rests against the bottom edge, which is exactly where the keyboard
    // is. Opening one from the composer put the whole card behind it — invisible,
    // and its rows unreachable. Every sheet in this app is a list or a set of
    // buttons, none of them holds a text field, so there is never a reason for
    // the keyboard to stay up over one.
    Keyboard.dismiss();
  }, [visible]);

  // Read by the exit callback, which cannot use `visible` from a closure: an
  // exiting animation runs the config captured on the *last render the view
  // existed*, which is the one where `visible` was still true. A closure would
  // therefore always see the stale `true` and never unmount anything.
  const isVisible = useRef(visible);
  isVisible.current = visible;

  // Removed only once the exit has actually played. Guarded against a sheet
  // reopened mid-exit: the callback for the old animation still arrives, and
  // unmounting on it would delete a card that is on its way back in.
  const finishExit = useCallback(() => {
    if (isVisible.current) return;
    // Back to rest, so a sheet dismissed by a drag does not open next time
    // already pushed halfway down the screen.
    drag.value = 0;
    setPresent(false);
  }, [drag]);

  /**
   * Entering: from exactly its own height below its resting place.
   *
   * `targetHeight` is measured by Reanimated on the UI thread, in the same
   * frame the view is laid out. That is the whole reason this is a custom
   * animation rather than `SlideInDown`, which travels a full window height —
   * a card that rests on the bottom edge should rise by its own height and no
   * more, or the visible part of the movement is a burst rather than a travel.
   *
   * It also replaces the measure-into-React-state round trip this component
   * used to do, which cost two extra renders and left the first frame hidden.
   */
  const entering = useCallback(
    (values: EntryAnimationsValues) => {
      "worklet";
      return {
        initialValues: { originY: values.targetOriginY + values.targetHeight },
        animations: {
          originY: reduceMotion
            ? withTiming(values.targetOriginY, INSTANT)
            : withSpring(values.targetOriginY, ARRIVE),
        },
      };
    },
    [reduceMotion],
  );

  const exiting = useCallback(
    (values: ExitAnimationsValues) => {
      "worklet";
      const gone = values.currentOriginY + values.currentHeight;
      return {
        initialValues: { originY: values.currentOriginY },
        animations: {
          originY: withTiming(gone, reduceMotion ? INSTANT : DEPART),
        },
        callback: () => {
          "worklet";
          runOnJS(finishExit)();
        },
      };
    },
    [reduceMotion, finishExit],
  );

  // Written from `onLayout` into a shared value rather than state: the gesture
  // needs the card's height to know what a quarter of it is, and nothing about
  // rendering does. Declared before the gesture, which captures it — a worklet
  // closes over its variables when it is built, not when it runs.
  const layoutHeight = useSharedValue(0);

  const dismiss = onClose;
  // The card follows the finger one-to-one downward and refuses to go up: a
  // sheet already flush against the bottom edge has nothing above it to reveal,
  // and letting it lift would show daylight underneath.
  const dragGesture = useMemo(
    () =>
      Gesture.Pan()
        .enabled(dismiss !== undefined && !reduceMotion)
        .onChange((event) => {
          drag.value = Math.max(0, drag.value + event.changeY);
        })
        .onEnd((event) => {
          const height = layoutHeight.value;
          const farEnough = height > 0 && drag.value > height * DISMISS_FRACTION;
          if (farEnough || event.velocityY > DISMISS_VELOCITY) {
            // Left exactly where the finger let go. The exit animation carries
            // it the rest of the way down from here, so the card never snaps
            // back up a single point before leaving.
            runOnJS(haptics.tap)();
            if (dismiss) runOnJS(dismiss)();
            return;
          }
          drag.value = withSpring(0, RETURN);
        }),
    [dismiss, reduceMotion, drag, layoutHeight],
  );

  const cardStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: drag.value }],
  }));

  // The scrim thins as the card is dragged away, so the conversation behind it
  // comes back under the thumb. Not linear with the drag: it reaches full
  // brightness at 70% of the travel, because a scrim that is still visibly dark
  // at the point of release makes the dismissal read as reluctant.
  const scrimDragStyle = useAnimatedStyle(() => ({
    opacity:
      layoutHeight.value > 0
        ? interpolate(drag.value, [0, layoutHeight.value * 0.7], [1, 0], "clamp")
        : 1,
  }));

  if (!present) return null;

  return (
    <View style={styles.host} pointerEvents="box-none">
      {/* Tapping away is the primary dismissal, so the scrim is a control —
          except on a blocking sheet, where it is only a dimming layer that
          still absorbs touches meant for the conversation.

          Two nested animated views, because they are driven by two different
          things: the outer fades with the sheet's own presence, the inner with
          the drag. One view cannot carry both a layout animation and an
          animated style for the same property. */}
      {visible && (
        <Animated.View
          style={StyleSheet.absoluteFill}
          entering={FadeIn.duration(ARRIVE.duration)}
          exiting={FadeOut.duration(DEPART.duration)}
          pointerEvents="box-none"
        >
          {onClose ? (
            <Pressable
              style={StyleSheet.absoluteFill}
              accessibilityRole="button"
              accessibilityLabel={dismissLabel ?? `Dismiss ${title}`}
              onPress={onClose}
            >
              <Animated.View style={[styles.scrim, scrimDragStyle]} />
            </Pressable>
          ) : (
            <Animated.View style={[StyleSheet.absoluteFill, styles.scrim]} />
          )}
        </Animated.View>
      )}

      {visible && (
        <Animated.View entering={entering} exiting={exiting}>
          <Animated.View
            onLayout={(event) => {
              layoutHeight.value = event.nativeEvent.layout.height;
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
                every sheet's body is a scrolling list, and a pan over one would
                have to win a fight against the scroll on every gesture. The
                grabber sits inside it, so the affordance is where the gesture
                actually is. */}
            <GestureDetector gesture={dragGesture}>
              {/* Not collapsable: React Native flattens a View that adds no
                  styling of its own, and gesture-handler needs a real native
                  view to attach to. */}
              <View collapsable={false}>
                <View style={styles.grabber} />

                <View style={styles.header}>
                  {/* Keyed, and that is what makes the fade happen at all: both
                      branches render a CircleButton at the same position, so
                      without distinct keys React reconciles one instance, the
                      icon never remounts, and the swap hard-cuts. */}
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
        </Animated.View>
      )}
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
