/**
 * Where an attachment comes from: library, camera, or files.
 *
 * A sheet rather than an action popover for the same reason as `CommandSheet`:
 * it arrives from the edge the thumb is already at, and picking a source is a
 * deliberate choice rather than a menu to skim. The chrome is the shared
 * `Sheet`, so this reads as the same object as the command and approval sheets.
 *
 * The three sources are listed even when one will fail: a phone with camera
 * access denied still shows "Take Photo", and refusing at that point is what
 * produces a message naming Settings. Hiding the row instead would leave the
 * user with a missing feature and no explanation.
 */
import { memo } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { touchSlop } from "./controls";
import { Sheet, SHEET_ROW_HEIGHT, sheetCardStyle } from "./Sheet";

export type AttachmentSource = "library" | "camera" | "files";

interface AttachmentSheetProps {
  visible: boolean;
  onSelect: (source: AttachmentSource) => void;
  onClose: () => void;
}

const SOURCES: {
  id: AttachmentSource;
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  hint: string;
}[] = [
  { id: "library", icon: "images-outline", label: "Photo Library", hint: "Screenshots and photos" },
  { id: "camera", icon: "camera-outline", label: "Take Photo", hint: "Point at a screen or a whiteboard" },
  { id: "files", icon: "document-outline", label: "Files", hint: "Logs, diffs, anything else" },
];

function AttachmentSheetView({ visible, onSelect, onClose }: AttachmentSheetProps) {
  return (
    <Sheet visible={visible} title="Attach" onClose={onClose} dismissLabel="Close attachments">
      <View style={styles.card}>
        {SOURCES.map((source, index) => (
          <Pressable
            key={source.id}
            style={({ pressed }) => [
              styles.row,
              // Never under the last row: a rule at the card's edge reads as a
              // broken border.
              index < SOURCES.length - 1 && styles.rowDivided,
              pressed && styles.rowPressed,
            ]}
            hitSlop={touchSlop(theme.space(1))}
            accessibilityRole="button"
            accessibilityLabel={`${source.label}. ${source.hint}`}
            onPress={() => onSelect(source.id)}
          >
            <Ionicons name={source.icon} size={20} color={theme.color.text} />
            <View style={styles.labels}>
              <Text style={styles.label} numberOfLines={1}>
                {source.label}
              </Text>
              <Text style={styles.hint} numberOfLines={1}>
                {source.hint}
              </Text>
            </View>
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  card: sheetCardStyle,
  row: {
    height: SHEET_ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    paddingHorizontal: theme.space(4),
  },
  rowDivided: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border,
  },
  rowPressed: { backgroundColor: theme.color.surfacePressed },
  labels: { flex: 1, gap: theme.space(0.5) },
  label: {
    color: theme.color.text,
    fontSize: theme.font.body,
    fontWeight: "600",
  },
  hint: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
  },
});

export const AttachmentSheet = memo(AttachmentSheetView);
