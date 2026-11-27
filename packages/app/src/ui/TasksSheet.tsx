/**
 * GG Coder's project task list (its desktop Tasks pane): in progress, to do,
 * done. Run starts a to-do task in this chat on a fresh context, as GG Coder does.
 * Ordering lives in `ggTasks.ts` (Expo-free, tested).
 */
import { memo, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { Sheet } from "./Sheet";
import { StageScroll } from "./stage/StageScroll";
import { Led, type LedTone } from "./stage/Led";
import { Pixel } from "./stage/Pixel";
import { dashedOutline } from "./stage/DashedRule";
import { Dissolve } from "./motion/Dissolve";
import { withAlpha } from "../motion";
import { groupTasks, runBlockedReason, type TaskBand } from "../ggTasks";
import type { TaskItem } from "../ggState";

const BAND_TONE: Record<TaskBand, LedTone> = {
  "in-progress": "agent",
  pending: "attention",
  done: "dim",
};
const STATUS_LABEL: Record<TaskBand, string> = {
  "in-progress": "in progress",
  pending: "to do",
  done: "done",
};

function StateGlyph({ band }: { band: TaskBand }) {
  if (band === "done")
    return (
      <View style={[styles.glyph, { backgroundColor: withAlpha(theme.color.success, 0.15) }]}>
        <Ionicons name="checkmark" size={14} color={theme.color.success} />
      </View>
    );
  if (band === "in-progress")
    return (
      <View style={styles.glyph}>
        <Pixel kind="live" />
      </View>
    );
  return <View style={[styles.glyph, styles.glyphTodo]} />;
}

function TaskRowView({
  task,
  online,
  busy,
  onRun,
}: {
  task: TaskItem;
  online: boolean;
  busy: boolean;
  onRun: (task: TaskItem) => void;
}) {
  const [open, setOpen] = useState(false);
  const runnable = task.runPrompt !== null;
  const blocked = runnable ? runBlockedReason(online, busy) : undefined;
  const disabled = blocked !== undefined;
  return (
    <View>
      <View style={styles.itemTop}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`${task.title}, ${STATUS_LABEL[task.status]}`}
          accessibilityState={{ expanded: open }}
          onPress={() => {
            haptics.tap();
            setOpen((o) => !o);
          }}
          style={styles.itemMain}
        >
          <StateGlyph band={task.status} />
          <Text
            style={[styles.itemTitle, task.status === "done" && styles.doneTitle]}
            numberOfLines={1}
          >
            {task.title || task.prompt}
          </Text>
        </Pressable>
        {runnable ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Run ${task.title}`}
            accessibilityHint={blocked ?? "Clears this chat and starts this task"}
            accessibilityState={{ disabled }}
            disabled={disabled}
            hitSlop={8}
            style={({ pressed }) => [
              styles.runButton,
              disabled && styles.dim,
              pressed && styles.pressed,
            ]}
            onPress={() => {
              haptics.sent();
              onRun(task);
            }}
          >
            <Led size={10}>Run</Led>
          </Pressable>
        ) : null}
      </View>
      {open ? (
        <Dissolve kind="row" dissolveKey={task.id}>
          <View style={styles.detail}>
            <Text style={styles.dimText}>{task.prompt}</Text>
            {blocked ? <Text style={styles.hint}>{blocked}</Text> : null}
          </View>
        </Dissolve>
      ) : null}
    </View>
  );
}

function TasksSheetView({
  visible,
  items,
  error,
  online,
  busy,
  onClose,
  onRun,
}: {
  visible: boolean;
  items?: TaskItem[];
  error?: string;
  /** Run marks the task on the computer, so it waits for a connection. */
  online: boolean;
  /** The daemon refuses a Run while this chat's agent is working. */
  busy: boolean;
  onClose: () => void;
  onRun: (task: TaskItem) => void;
}) {
  const groups = items ? groupTasks(items) : [];
  const todo = items?.filter((t) => t.status === "pending").length ?? 0;
  let row = 0;
  return (
    <Sheet
      visible={visible}
      label="Tasks"
      title={!items ? "Tasks" : items.length === 0 ? "No tasks" : `${todo} to do`}
      onClose={onClose}
    >
      <StageScroll style={styles.scroll} contentContainerStyle={styles.body}>
        {error ? <Text style={styles.dimText}>{error}</Text> : null}
        {!items && !error ? <Text style={styles.dimText}>Loading…</Text> : null}
        {items?.length === 0 ? (
          <Text style={styles.dimText}>
            No tasks for this project yet. Ask GG Coder to add some.
          </Text>
        ) : null}
        {groups.map((g) => (
          <View key={g.band} style={styles.group}>
            <Led tone={BAND_TONE[g.band]}>{`${g.label} · ${g.items.length}`}</Led>
            <View>
              {g.items.map((task) => (
                <Dissolve key={task.id} kind="row" delay={row++ * 40}>
                  <TaskRowView task={task} online={online} busy={busy} onRun={onRun} />
                </Dissolve>
              ))}
            </View>
          </View>
        ))}
      </StageScroll>
    </Sheet>
  );
}
export const TasksSheet = memo(TasksSheetView);

const styles = StyleSheet.create({
  scroll: { maxHeight: 560 },
  body: { gap: theme.space(3), paddingBottom: theme.space(2) },
  group: { gap: theme.space(1.5) },
  glyph: { width: 20, height: 20, borderRadius: 5, alignItems: "center", justifyContent: "center" },
  glyphTodo: {
    borderWidth: 1.5,
    borderStyle: "dashed",
    borderColor: theme.color.attention,
    width: 16,
    height: 16,
    margin: 2,
    borderRadius: 3,
  },
  itemTop: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    minHeight: theme.size.touch,
  },
  itemMain: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    paddingVertical: theme.space(2.5),
  },
  itemTitle: { flex: 1, color: theme.color.text, fontSize: theme.font.body },
  doneTitle: { color: theme.color.textDim },
  detail: {
    gap: theme.space(1.5),
    paddingLeft: 20 + theme.space(3),
    paddingBottom: theme.space(3),
  },
  dimText: { color: theme.color.textDim, fontSize: theme.font.small },
  hint: { color: theme.color.textFaint, fontSize: theme.font.tiny },
  runButton: {
    ...dashedOutline,
    borderRadius: theme.radius.pill,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(1),
  },
  dim: { opacity: 0.5 },
  pressed: { opacity: 0.7 },
});
