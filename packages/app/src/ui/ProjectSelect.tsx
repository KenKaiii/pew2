/**
 * "Which project?" — the second axis of the drawer.
 *
 * The list below is the agent's most recent conversations, which answers "what
 * was I just doing" and nothing else: a repo left alone for a fortnight has no
 * rows in it at all. This control is how you get back to that repo — it filters
 * the history to one project *and* decides where the next conversation opens,
 * because those are the same intent expressed once.
 *
 * It sits directly under the app chips because it is subordinate to them:
 * projects belong to the selected agent, so changing agent changes what this
 * offers. Default is "All projects", so the drawer behaves exactly as it always
 * has until a choice is made.
 *
 * The menu is an in-tree overlay inside the drawer panel, matching
 * `ConfigPicker`: a `Modal` is its own native window and presenting one resigns
 * first responder, which would drop the keyboard out from under the composer.
 * It is rendered by the sidebar so it can hang below this row's measured
 * bottom edge and drop over the history list, the way a menu should.
 */
import { memo } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { Glass } from "./Glass";
import { haptics } from "./haptics";
import { projectLabel, type Project } from "../projects";

interface ProjectSelectProps {
  /** The chosen project, or undefined for all of them. */
  selected?: Project;
  /** How many projects there are. Zero hides the row entirely. */
  count: number;
  open: boolean;
  onToggle: () => void;
  /** Reports the row's height so the menu can hang from its bottom edge. */
  onLayout?: (event: LayoutChangeEvent) => void;
}

function ProjectSelectView({ selected, count, open, onToggle, onLayout }: ProjectSelectProps) {
  // An agent that has never been used has nothing to choose between, and an
  // empty dropdown is a control that can only disappoint. One project still
  // earns the row: it says where the next conversation will open.
  if (count === 0) return null;

  return (
    <View style={styles.host} onLayout={onLayout}>
      {/* `radius.pill`, matching the model and config selectors in the top bar.
          This is the same kind of control — a labelled value that opens a menu —
          and it was the one rounded rectangle among them, which read as a
          different species of thing. */}
      <Glass radius={theme.radius.pill} interactive>
        <Pressable
          accessibilityRole="button"
          // Named as a setting with a value, so it is spoken as "Project, all
          // projects" rather than as a bare folder name of no clear purpose.
          accessibilityLabel={`Project: ${projectLabel(selected)}`}
          // Says both jobs, because the second one is not guessable: this is
          // also where the next conversation will be started.
          accessibilityHint="Choose which project to show conversations from and start new ones in"
          accessibilityState={{ expanded: open }}
          onPress={() => {
            haptics.tap();
            onToggle();
          }}
          style={({ pressed }) => [styles.control, pressed && styles.pressed]}
        >
          <Ionicons
            name="folder-outline"
            size={15}
            color={selected ? theme.color.text : theme.color.textDim}
          />
          <Text
            style={[styles.label, !selected && styles.labelAll]}
            numberOfLines={1}
          >
            {projectLabel(selected)}
          </Text>
          {/* Points at the menu it opens, and flips once it is open, so the row
              says where the list came from. */}
          <Ionicons
            name={open ? "chevron-up" : "chevron-down"}
            size={14}
            color={theme.color.textDim}
          />
        </Pressable>
      </Glass>
    </View>
  );
}

const styles = StyleSheet.create({
  // Same gutter as the chips above and the list below: this is a rail the whole
  // drawer shares, and stepping it in would read as a nested panel.
  host: { marginHorizontal: theme.gutter, marginTop: theme.sectionGap },
  control: {
    flexDirection: "row",
    alignItems: "center",
    // Both taken from `Pill` in `controls.tsx`, so this control has the same
    // anatomy as its peers rather than merely the same corner radius.
    gap: theme.space(1.5),
    height: theme.size.control,
    paddingHorizontal: theme.space(4),
  },
  label: {
    color: theme.color.text,
    fontSize: theme.font.small,
    lineHeight: theme.font.small + 4,
    // Takes the row, so the chevron stays pinned to the right edge however long
    // the project name is.
    flex: 1,
  },
  // Unset reads as a default rather than a choice, so it is dimmed to the same
  // weight as the "Latest chats" label below it.
  labelAll: { color: theme.color.textDim },
  pressed: { opacity: 0.6 },
});

export const ProjectSelect = memo(ProjectSelectView);
