/**
 * One message, as text you can take away.
 *
 * The transcript renders markdown into dozens of separate `Text` nodes — a
 * paragraph here, a bold run there, a fenced block in its own view — and a
 * selection on this platform cannot cross from one `Text` into the next. So
 * there is no gesture on the rendered turn that can select the whole reply, and
 * the answer someone actually wants to keep is the one thing the app could not
 * give them. This sheet is that turn as a single selectable node, which is also
 * the only shape a drag-select can span.
 *
 * Deliberately the *source*, not the rendering: `**bold**` shows its asterisks
 * here. What is on screen is then exactly what Copy puts on the clipboard, and
 * a reply pasted into an editor arrives as the markdown the agent wrote rather
 * than as flattened prose.
 *
 * Chrome and card height are `ThoughtSheet`'s, because "open a turn's full text"
 * is one idea and reading a thought and copying an answer should not be two
 * different objects.
 */
import { memo, useEffect, useRef, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import Ionicons from "@expo/vector-icons/Ionicons";
import * as Clipboard from "expo-clipboard";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { writeToClipboard } from "./clipboard";
import { Sheet, SHEET_CARD_HEIGHT, sheetCardStyle } from "./Sheet";

interface MessageSheetProps {
  visible: boolean;
  text: string;
  onClose: () => void;
}

type CopyState = "idle" | "copied" | "failed";

/**
 * The action rail's height, taken out of the card rather than added to it: the
 * sheet's card height is shared with every other sheet, and growing this one by
 * a row would make "copy a message" a visibly taller object than "read a
 * thought" for no reason the user could name.
 */
const ACTION_ROW_HEIGHT = theme.size.control + theme.space(2);

function MessageSheetView({ visible, text, onClose }: MessageSheetProps) {
  // The closed state carries no text, so the card would empty on the first
  // frame of the exit and the sheet would slide away blank. Same reason as
  // `ThoughtSheet`: hold the last message until another replaces it.
  const held = useRef(text);
  if (text) held.current = text;

  const [copyState, setCopyState] = useState<CopyState>("idle");

  useEffect(() => {
    if (copyState === "idle") return undefined;
    const reset = setTimeout(() => setCopyState("idle"), 1800);
    return () => clearTimeout(reset);
  }, [copyState]);

  // Reset on close as well as on a timer: a sheet reopened within the window
  // would otherwise say "Copied" about the message before it.
  useEffect(() => {
    if (!visible) setCopyState("idle");
  }, [visible]);

  const copy = async () => {
    const copied = await writeToClipboard(held.current, Clipboard.setStringAsync);
    if (copied) haptics.finished();
    else haptics.failed();
    setCopyState(copied ? "copied" : "failed");
  };

  const label = copyState === "copied" ? "Copied" : copyState === "failed" ? "Try again" : "Copy";
  const icon =
    copyState === "copied"
      ? "checkmark"
      : copyState === "failed"
        ? "alert-circle-outline"
        : "copy-outline";

  return (
    <Sheet visible={visible} title="Message" onClose={onClose} dismissLabel="Close message">
      <View style={styles.card}>
        <ScrollView style={styles.scroll} contentContainerStyle={styles.content}>
          {/* The whole turn in one node. Splitting it for prettier rendering is
              exactly what this sheet exists to undo. */}
          <Text selectable style={styles.text}>
            {held.current}
          </Text>
        </ScrollView>
        <View style={styles.actions}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Copy message"
            accessibilityState={{ selected: copyState === "copied" }}
            onPress={() => void copy()}
            style={({ pressed }) => [styles.copyButton, pressed && styles.copyButtonPressed]}
          >
            <Ionicons
              name={icon}
              size={16}
              color={copyState === "failed" ? theme.color.danger : theme.color.text}
            />
            <Text style={[styles.copyLabel, copyState === "failed" && styles.copyLabelFailed]}>
              {label}
            </Text>
          </Pressable>
        </View>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  card: sheetCardStyle,
  // The action row is a fixed rail under a fixed reading area, so a one-line
  // message and a long reply open the same object — and Copy is in the same
  // place both times, rather than wherever the text happened to end.
  scroll: { height: SHEET_CARD_HEIGHT - ACTION_ROW_HEIGHT },
  content: { padding: theme.space(4) },
  text: {
    color: theme.color.text,
    fontSize: theme.font.body,
    lineHeight: theme.line.body,
  },
  actions: {
    height: ACTION_ROW_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.border,
  },
  copyButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1.5),
    minHeight: theme.size.touch,
    paddingHorizontal: theme.space(4),
    borderRadius: theme.radius.pill,
  },
  copyButtonPressed: { backgroundColor: theme.color.surfacePressed },
  copyLabel: { color: theme.color.text, fontSize: theme.font.body, fontWeight: "600" },
  copyLabelFailed: { color: theme.color.danger },
});

export const MessageSheet = memo(MessageSheetView);
