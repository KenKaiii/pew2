/**
 * The project dropdown.
 *
 * Hangs from the bottom edge of the select row inside the drawer panel, so it
 * reads as that row opening rather than a dialog arriving from nowhere. It is
 * an in-tree overlay, not a `Modal`, for the same reason as `ConfigPicker`: a
 * Modal is its own native window and presenting one resigns first responder,
 * dropping the keyboard mid-sentence.
 *
 * Rows are project name plus conversation count, because the count is what
 * tells two similarly named repos apart at a glance — and "All projects" is
 * always first and always present, since undoing a filter must never require
 * hunting for the thing you filtered by.
 */
import { memo, useEffect, useRef } from "react";
import {
  Animated,
  BackHandler,
  Easing,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { Glass } from "./Glass";
import { haptics } from "./haptics";
import { useReducedMotion } from "./useReducedMotion";
import type { Project } from "../projects";

/**
 * Ceiling for the menu. Short lists shrink to fit; a machine with forty repos
 * scrolls inside this instead of running past the bottom of the drawer.
 */
const MAX_MENU_HEIGHT = 320;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

interface ProjectMenuProps {
  visible: boolean;
  projects: Project[];
  /** Path of the chosen project, or undefined for all of them. */
  selectedPath?: string;
  /** Distance from the top of the drawer to the bottom of the select row. */
  top: number;
  onSelect: (path?: string) => void;
  onClose: () => void;
}

function ProjectMenuView({
  visible,
  projects,
  selectedPath,
  top,
  onSelect,
  onClose,
}: ProjectMenuProps) {
  const progress = useRef(new Animated.Value(0)).current;
  const reduceMotion = useReducedMotion();

  // Entrance only: the menu unmounts the moment a project is chosen, because a
  // fading-out overlay is one that still covers the list you just filtered.
  // Reset on the way in, since the same instance is reused next time.
  useEffect(() => {
    if (!visible) {
      progress.setValue(0);
      return;
    }
    const animation = Animated.timing(progress, {
      toValue: 1,
      duration: reduceMotion ? 0 : theme.motion.base,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [visible, reduceMotion, progress]);

  // An overlay has to claim the Android back button, or back would leave the
  // menu open and exit the app instead.
  useEffect(() => {
    if (!visible) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onClose();
      return true;
    });
    return () => subscription.remove();
  }, [visible, onClose]);

  // Unmounted while hidden, or it would keep swallowing taps meant for the
  // conversation list underneath.
  if (!visible) return null;

  return (
    <View style={styles.host} pointerEvents="box-none">
      {/* Tap anywhere else to dismiss. Covers the whole drawer, including the
          rows behind the menu, so a stray tap closes rather than opening the
          wrong conversation.

          It dims as well as catches. The card itself is opaque, so this is not
          doing the legibility work — it is what makes the menu read as the only
          live thing on the panel, and what keeps the rows it does not cover
          from competing with it. Confined to the drawer because this menu
          belongs to the drawer. */}
      <AnimatedPressable
        style={[styles.scrim, { opacity: progress }]}
        accessibilityRole="button"
        accessibilityLabel="Close project menu"
        onPress={onClose}
      />
      <Animated.View
        style={[
          styles.card,
          {
            top,
            opacity: progress,
            transformOrigin: "top",
            transform: [
              { scale: progress.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) },
            ],
          },
        ]}
      >
        <Glass radius={theme.radius.lg} tier="raised" style={styles.cardGlass}>
          <ScrollView
            style={styles.scroll}
            contentContainerStyle={styles.cardInner}
            showsVerticalScrollIndicator={false}
          >
            <ProjectRow
              name="All projects"
              detail={`${projects.length} project${projects.length === 1 ? "" : "s"}`}
              selected={selectedPath === undefined}
              onPress={() => onSelect(undefined)}
            />
            <View style={styles.divider} />
            {projects.map((project) => (
              <ProjectRow
                key={project.path}
                name={project.name}
                detail={
                  project.sessions === undefined
                    ? undefined
                    : `${project.sessions} conversation${project.sessions === 1 ? "" : "s"}`
                }
                selected={project.path === selectedPath}
                onPress={() => onSelect(project.path)}
              />
            ))}
          </ScrollView>
        </Glass>
      </Animated.View>
    </View>
  );
}

function ProjectRow({
  name,
  detail,
  selected,
  onPress,
}: {
  name: string;
  detail?: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={detail ? `${name}, ${detail}` : name}
      accessibilityState={{ selected }}
      onPress={() => {
        // Selection, not impact: a value changing in a list, the same gesture
        // family as the model picker.
        haptics.select();
        onPress();
      }}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      <View style={styles.rowText}>
        <Text style={styles.rowName} numberOfLines={1}>
          {name}
        </Text>
        {detail ? (
          <Text style={styles.rowDetail} numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {selected && <Ionicons name="checkmark" size={18} color={theme.color.text} />}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  // Fills the drawer panel, which clips it: the menu can drop over the history
  // list but never past the panel's own rounded edge.
  host: { ...StyleSheet.absoluteFillObject, zIndex: 5 },
  // Lighter than it would need to be for legibility, because the opaque card
  // above already handles that; this only has to push the panel back.
  scrim: { ...StyleSheet.absoluteFillObject, backgroundColor: "rgba(0,0,0,0.4)" },
  card: {
    position: "absolute",
    left: theme.gutter,
    right: theme.gutter,
    // Small gap under the row it belongs to, matching the model picker's.
    marginTop: theme.space(1.5),
    maxHeight: MAX_MENU_HEIGHT,
    // Opaque disc behind the glass, and the reason this menu differs from every
    // other glass surface in the app: those sit over a blur that already reads
    // as a background, while this one floats directly on a list of conversation
    // titles. Glass is translucent by definition, so without a fill the titles
    // read straight through the project names — two sets of words in the same
    // space. The radius is repeated here because the fill is *behind* the
    // material that clips, not inside it.
    backgroundColor: theme.color.surfaceRaised,
    borderRadius: theme.radius.lg,
  },
  cardGlass: { width: "100%", flexShrink: 1 },
  scroll: { flexGrow: 0 },
  cardInner: { padding: theme.space(2) },
  divider: {
    height: StyleSheet.hairlineWidth,
    backgroundColor: theme.color.border,
    marginVertical: theme.space(1),
    marginHorizontal: theme.space(2),
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.space(2),
    minHeight: theme.size.touch,
    paddingHorizontal: theme.space(3),
    // Two lines of type need more room than a bare 44pt target gives them, or
    // name and count sit on top of each other.
    paddingVertical: theme.space(1.5),
    borderRadius: theme.radius.md,
  },
  rowPressed: { backgroundColor: theme.glass.fillPressed },
  // Yields to the checkmark rather than pushing it off the row.
  rowText: { flexShrink: 1 },
  rowName: {
    color: theme.color.text,
    fontSize: theme.font.body,
    lineHeight: theme.line.body,
  },
  rowDetail: { color: theme.color.textDim, fontSize: theme.font.tiny },
});

export const ProjectMenu = memo(ProjectMenuView);
