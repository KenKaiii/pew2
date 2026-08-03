/**
 * "New chat" — where?
 *
 * The button used to start a conversation the instant it was tapped, which
 * meant a new chat always landed wherever the agent happened to be. That is the
 * right guess most of the time and unfixable from the phone the rest of it: the
 * only way to work in another repo was to walk back to the desk.
 *
 * So it asks, in one tap either way. The first step names the project you are
 * already in, because continuing here is the common case and it should not cost
 * a list. The second step is that list, for the times it is not.
 *
 * A sheet rather than the drawer's dropdown: this is a decision that starts
 * something, taken from the conversation, and it belongs on the same bottom
 * edge as commands and approvals rather than behind a menu in another panel.
 *
 * The two steps are a **push**, not a swap: the list arrives from the right as
 * the choices leave to the left, and the card resizes under them. Both steps
 * stay mounted so neither has to be rebuilt mid-travel, and the hidden one is
 * inert. A cut between two cards of different heights reads as the sheet
 * flinching; this reads as one object with somewhere to go.
 */
import { memo, useEffect, useRef, useState } from "react";
import { Animated, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { touchSlop } from "./controls";
import { Sheet, SHEET_ROW_HEIGHT, SHEET_VISIBLE_ROWS, sheetCardStyle } from "./Sheet";
import { haptics } from "./haptics";
import { useReducedMotion } from "./useReducedMotion";
import type { Project } from "../projects";

/**
 * The push, tuned to sit just inside `Sheet`'s own arrival.
 *
 * Stiffer and lighter than the sheet's spring: this is a pane moving *within* a
 * card already on screen, and matching the sheet's travel would read as the
 * whole thing being re-presented. Critically damped, because a horizontal
 * overshoot on a list of projects looks like a bounce rather than a push.
 */
const STEP_SPRING = {
  damping: 30,
  stiffness: 320,
  mass: 0.85,
  restDisplacementThreshold: 0.001,
  restSpeedThreshold: 0.01,
} as const;

interface NewChatSheetProps {
  visible: boolean;
  /** The project the open conversation is in. Absent until the daemon answers. */
  currentFolder?: string;
  currentCwd?: string;
  projects: Project[];
  /** Starts a conversation in `cwd`, or wherever the agent last was when absent. */
  onStart: (cwd?: string) => void;
  onClose: () => void;
}

function NewChatSheetView({
  visible,
  currentFolder,
  currentCwd,
  projects,
  onStart,
  onClose,
}: NewChatSheetProps) {
  const [picking, setPicking] = useState(false);
  const reduceMotion = useReducedMotion();

  // Nothing to switch between, so there is no second step to offer: one project
  // (or none known yet) makes the list a dead end.
  const canPick = projects.length > 1;

  // Two values for one movement, because they cannot share a driver: transforms
  // and opacity run on the native thread, `height` cannot. Started together and
  // with the same spring, so they are one gesture in everything but plumbing.
  const slide = useRef(new Animated.Value(0)).current;
  const resize = useRef(new Animated.Value(0)).current;

  // Measured, never assumed: step one is two fixed rows but step two is a list
  // whose height depends on the machine, and a guess would make the card settle
  // at the wrong size and then correct itself.
  const [heights, setHeights] = useState<[number, number]>([0, 0]);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const target = picking ? 1 : 0;
    if (reduceMotion) {
      slide.setValue(target);
      resize.setValue(target);
      return;
    }
    const animation = Animated.parallel([
      Animated.spring(slide, { toValue: target, ...STEP_SPRING, useNativeDriver: true }),
      Animated.spring(resize, { toValue: target, ...STEP_SPRING, useNativeDriver: false }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [picking, reduceMotion, slide, resize]);

  // Always opens on the first step. A sheet that reopened onto the project list
  // because that is where it was last closed would hide its own primary action.
  //
  // Reset on the way *in*, not on the way out: `Sheet` stays mounted for its
  // exit animation, so clearing this on close swaps the list back to step one
  // while the card is still sliding down, in full view. Cut rather than
  // animated, since the sheet is off screen at the time — a push nobody can see
  // would only delay the next opening.
  useEffect(() => {
    if (!visible) return;
    setPicking(false);
    slide.setValue(0);
    resize.setValue(0);
  }, [visible, slide, resize]);

  // Only as tall as it needs to be, up to five rows — the same rule as the
  // command sheet, so the two read as one object at different lengths.
  const listHeight = Math.min(projects.length, SHEET_VISIBLE_ROWS) * SHEET_ROW_HEIGHT;
  const scrolls = projects.length > SHEET_VISIBLE_ROWS;

  // Before a step has been measured, fall back to the other one rather than to
  // zero: the card must never animate through a collapsed state on first open.
  const [firstHeight, secondHeight] = heights;
  const cardHeight = resize.interpolate({
    inputRange: [0, 1],
    outputRange: [firstHeight || secondHeight || 1, secondHeight || firstHeight || 1],
  });

  // Full-width travel, so each pane leaves and arrives at the card's own edge.
  // Falls back to zero until measured, which reads as a cross-fade for the one
  // frame before layout lands.
  const outgoing = slide.interpolate({ inputRange: [0, 1], outputRange: [0, -width] });
  const incoming = slide.interpolate({ inputRange: [0, 1], outputRange: [width, 0] });
  // Faster than the travel: a pane at the halfway point is already mostly gone,
  // which is what stops the two lists from reading as one doubled list.
  const outgoingFade = slide.interpolate({
    inputRange: [0, 0.6],
    outputRange: [1, 0],
    extrapolate: "clamp",
  });
  const incomingFade = slide.interpolate({
    inputRange: [0.4, 1],
    outputRange: [0, 1],
    extrapolate: "clamp",
  });

  const push = () => {
    haptics.tap();
    setPicking(true);
  };
  const pop = () => {
    haptics.tap();
    setPicking(false);
  };

  return (
    <Sheet
      visible={visible}
      title={picking ? "Choose project" : "New chat"}
      onClose={onClose}
      onBack={picking ? pop : undefined}
      dismissLabel="Close new chat"
    >
      <Animated.View
        style={[styles.card, { height: cardHeight }]}
        onLayout={(event) => setWidth(event.nativeEvent.layout.width)}
      >
        {/* Step one. Absolute so both panes occupy the same box and the card's
            animated height is the only thing deciding its size. */}
        <Animated.View
          style={[styles.pane, { opacity: outgoingFade, transform: [{ translateX: outgoing }] }]}
          // Inert once pushed past, or the invisible pane keeps taking the taps
          // meant for the list on top of it.
          pointerEvents={picking ? "none" : "auto"}
          onLayout={(event) => {
            const measured = event.nativeEvent.layout.height;
            setHeights((prev) => (prev[0] === measured ? prev : [measured, prev[1]]));
          }}
        >
          <Row
            icon="add-circle-outline"
            // Named, so the row is not a restatement of the sheet's own title.
            // Before the daemon has answered there is no name to use, and the
            // detail line carries the meaning instead.
            title={currentFolder ? `New chat in ${currentFolder}` : "Start a new chat"}
            detail={currentFolder ? "Continue in this project" : "Where the agent last worked"}
            divided={canPick}
            onPress={() => onStart(currentCwd)}
          />
          {canPick && (
            <Row
              icon="folder-open-outline"
              title="Different project"
              detail={`${projects.length} projects`}
              chevron
              onPress={push}
            />
          )}
        </Animated.View>

        {/* Step two. Mounted from the start so the push has something real to
            move; without it the first frame of the travel is an empty pane. */}
        {canPick && (
          <Animated.View
            style={[styles.pane, { opacity: incomingFade, transform: [{ translateX: incoming }] }]}
            pointerEvents={picking ? "auto" : "none"}
            onLayout={(event) => {
              const measured = event.nativeEvent.layout.height;
              setHeights((prev) => (prev[1] === measured ? prev : [prev[0], measured]));
            }}
          >
            <ScrollView
              style={{ height: listHeight }}
              showsVerticalScrollIndicator={scrolls}
              bounces={scrolls}
            >
              {projects.map((project, index) => (
                <Row
                  key={project.path}
                  icon="folder-outline"
                  title={project.name}
                  detail={
                    project.path === currentCwd
                      ? "Current project"
                      : project.sessions === undefined
                        ? project.path
                        : `${project.sessions} conversation${project.sessions === 1 ? "" : "s"}`
                  }
                  divided={index < projects.length - 1}
                  onPress={() => onStart(project.path)}
                />
              ))}
            </ScrollView>
          </Animated.View>
        )}
      </Animated.View>
    </Sheet>
  );
}

function Row({
  icon,
  title,
  detail,
  divided,
  chevron,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  title: string;
  detail?: string;
  divided?: boolean;
  chevron?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={detail ? `${title}, ${detail}` : title}
      hitSlop={touchSlop(theme.space(1))}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        // Hairline between rows, never under the last one: a rule at the card's
        // edge reads as a broken border.
        divided && styles.rowDivided,
        pressed && styles.rowPressed,
      ]}
    >
      <Ionicons name={icon} size={20} color={theme.color.glyph} />
      <View style={styles.rowText}>
        <Text style={styles.rowTitle} numberOfLines={1}>
          {title}
        </Text>
        {!!detail && (
          <Text style={styles.rowDetail} numberOfLines={1}>
            {detail}
          </Text>
        )}
      </View>
      {/* Only on the row that leads somewhere: it promises a next step, and on
          a row that starts a chat it would be a lie. */}
      {chevron && <Ionicons name="chevron-forward" size={16} color={theme.color.textDim} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: sheetCardStyle,
  // Both panes share one box. `top: 0` with left/right pinned lets each measure
  // its own natural height while the card animates between the two.
  pane: { position: "absolute", left: 0, right: 0, top: 0 },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    height: SHEET_ROW_HEIGHT,
    paddingHorizontal: theme.space(4),
  },
  rowDivided: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border,
  },
  rowPressed: { backgroundColor: theme.glass.fillPressed },
  // Yields to the chevron rather than pushing it off the row.
  rowText: { flex: 1 },
  rowTitle: { color: theme.color.text, fontSize: theme.font.body },
  rowDetail: { color: theme.color.textDim, fontSize: theme.font.tiny },
});

export const NewChatSheet = memo(NewChatSheetView);
