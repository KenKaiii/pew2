/**
 * The files staged for the next message, above the composer.
 *
 * Shown outside the composer's glass on purpose: the pill's contents are
 * absolutely positioned against a height derived from the draft, so a row of
 * variable height inside it would make the text jump as files come and go.
 *
 * A picture shows its own thumbnail — recognising a screenshot at a glance is
 * the whole reason to look here — and anything else gets a glyph and its name.
 * Removal is a tap on the chip's own cross rather than a swipe: the row scrolls
 * horizontally, and a swipe would fight it.
 */
import { memo } from "react";
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { touchSlop } from "./controls";
import { haptics } from "./haptics";
import { formatSize, isImageAttachment, type PendingAttachment } from "../attachments";

interface AttachmentChipsProps {
  attachments: readonly PendingAttachment[];
  onRemove?: (id: string) => void;
}

const THUMB = 32;

function glyphFor(mimeType: string): keyof typeof Ionicons.glyphMap {
  if (mimeType.startsWith("image/")) return "image-outline";
  if (mimeType.startsWith("video/")) return "videocam-outline";
  if (mimeType.startsWith("audio/")) return "musical-notes-outline";
  if (mimeType === "application/pdf") return "document-text-outline";
  return "document-outline";
}

function AttachmentChipsView({ attachments, onRemove }: AttachmentChipsProps) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={styles.row}
      keyboardShouldPersistTaps="handled"
    >
      {attachments.map((file) => (
        <View key={file.id} style={styles.chip}>
          {isImageAttachment(file) && file.localUri ? (
            <Image source={{ uri: file.localUri }} style={styles.thumb} accessible={false} />
          ) : (
            <View style={styles.glyph}>
              <Ionicons name={glyphFor(file.mimeType)} size={16} color={theme.color.glyph} />
            </View>
          )}

          <View style={styles.labels}>
            {/* `middle` keeps the extension visible, which is most of what a
                long generated filename actually tells you. */}
            <Text style={styles.name} numberOfLines={1} ellipsizeMode="middle">
              {file.name}
            </Text>
            <Text style={styles.size}>{formatSize(file.size)}</Text>
          </View>

          {onRemove && (
            <Pressable
              style={({ pressed }) => [styles.remove, pressed && styles.removePressed]}
              hitSlop={touchSlop(theme.space(2))}
              accessibilityRole="button"
              accessibilityLabel={`Remove ${file.name}`}
              onPress={() => {
                haptics.tap();
                onRemove(file.id);
              }}
            >
              <Ionicons name="close" size={13} color={theme.color.textDim} />
            </Pressable>
          )}
        </View>
      ))}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  row: { gap: theme.space(2), paddingHorizontal: theme.space(1) },
  chip: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingLeft: theme.space(1),
    paddingRight: theme.space(2),
    paddingVertical: theme.space(1),
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
    // A name is elided rather than allowed to push the row wide enough that a
    // second attachment is off screen and unnoticed.
    maxWidth: 220,
  },
  thumb: { width: THUMB, height: THUMB, borderRadius: theme.space(2) },
  glyph: {
    width: THUMB,
    height: THUMB,
    borderRadius: theme.space(2),
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.color.surfaceRaised,
  },
  labels: { flexShrink: 1, gap: 1 },
  name: {
    color: theme.color.text,
    fontSize: theme.font.small,
    fontWeight: "600",
  },
  size: { color: theme.color.textFaint, fontSize: theme.font.tiny },
  remove: {
    width: 18,
    height: 18,
    borderRadius: 9,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.color.surfacePressed,
  },
  removePressed: { opacity: 0.6 },
});

export const AttachmentChips = memo(AttachmentChipsView);
