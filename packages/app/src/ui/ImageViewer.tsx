/**
 * Full-screen view of one picture, and the only place it can be saved.
 *
 * Transcript images are small and sit inside a scrolling list, so the save
 * action cannot live on the thumbnail: a button there competes with the scroll
 * gesture, and a long-press that silently writes to the camera roll gives no
 * confirmation. Tapping opens this instead — the picture at full size, with
 * Save and Share as ordinary buttons and the result stated in words.
 *
 * A real `Modal`, unlike `ConfigPicker`: this *is* leaving the conversation for
 * a moment, and the keyboard should drop.
 */
import { useCallback, useEffect, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Ionicons from "@expo/vector-icons/Ionicons";
import { theme } from "../theme";
import { haptics } from "./haptics";
import { saveImageToDevice, shareImage, type SaveResult } from "./imageSaver";
import type { ChatImage as ChatImageModel } from "../images";

/** What the last save/share attempt did, shown under the buttons. */
type Feedback = { tone: "ok" | "bad"; text: string };

function describe(result: SaveResult): Feedback {
  switch (result.status) {
    case "saved":
      return { tone: "ok", text: "Saved to your photos" };
    case "shared":
      return { tone: "ok", text: "Shared" };
    case "denied":
      // Not an error the app can fix, so it says where the switch is.
      return { tone: "bad", text: "Photos access is off — enable it in Settings" };
    case "error":
      return { tone: "bad", text: result.message };
  }
}

export function ImageViewer({
  image,
  resolvedSrc,
  visible,
  onClose,
}: {
  image: ChatImageModel;
  /** The displayable source — a data URI for anything that came off the desktop. */
  resolvedSrc: string;
  visible: boolean;
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const [busy, setBusy] = useState<"save" | "share" | undefined>(undefined);
  const [feedback, setFeedback] = useState<Feedback | undefined>(undefined);

  // Reopening is a fresh attempt: a stale "Saved" from last time would read as
  // confirmation of a save that has not happened yet.
  useEffect(() => {
    if (!visible) {
      setFeedback(undefined);
      setBusy(undefined);
    }
  }, [visible]);

  const run = useCallback(
    async (kind: "save" | "share") => {
      if (busy) return;
      setBusy(kind);
      setFeedback(undefined);
      const result =
        kind === "save"
          ? await saveImageToDevice(image, resolvedSrc)
          : await shareImage(image, resolvedSrc);
      // Named by meaning, so a refused permission feels different from a write
      // that actually landed.
      if (result.status === "saved" || result.status === "shared") haptics.finished();
      else haptics.failed();
      setFeedback(describe(result));
      setBusy(undefined);
    },
    [busy, image, resolvedSrc],
  );

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      // Android's hardware back closes the viewer rather than the app.
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <View style={styles.backdrop}>
        {/* Tapping the surround dismisses, matching every other overlay here. */}
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel="Close image"
          onPress={onClose}
        />

        <View style={[styles.closeRow, { top: insets.top + theme.headerInset }]}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close image"
            hitSlop={12}
            onPress={onClose}
            style={styles.closeButton}
          >
            <Ionicons name="close" size={20} color={theme.color.text} />
          </Pressable>
        </View>

        {/* Not interactive: taps fall through to the dismiss layer behind it,
            so tapping anywhere but the buttons closes the viewer. */}
        <View style={styles.image} pointerEvents="none">
          <Image
            accessible
            accessibilityRole="image"
            accessibilityLabel={image.alt || "Image from the agent"}
            source={{ uri: resolvedSrc }}
            resizeMode="contain"
            style={styles.imageFill}
          />
        </View>

        <View style={[styles.actions, { paddingBottom: insets.bottom + theme.space(4) }]}>
          {!!feedback && (
            <Text
              style={[
                styles.feedback,
                feedback.tone === "bad" && { color: theme.color.danger },
              ]}
            >
              {feedback.text}
            </Text>
          )}

          <View style={styles.buttonRow}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save image to photos"
              disabled={!!busy}
              onPress={() => void run("save")}
              style={({ pressed }) => [
                styles.button,
                styles.primaryButton,
                pressed && { opacity: 0.8 },
                !!busy && { opacity: 0.6 },
              ]}
            >
              {busy === "save" ? (
                <ActivityIndicator color={theme.color.text} size="small" />
              ) : (
                <Ionicons name="download-outline" size={18} color={theme.color.text} />
              )}
              <Text style={styles.buttonText}>Save</Text>
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Share image"
              disabled={!!busy}
              onPress={() => void run("share")}
              style={({ pressed }) => [
                styles.button,
                pressed && { backgroundColor: theme.color.surfacePressed },
                !!busy && { opacity: 0.6 },
              ]}
            >
              {busy === "share" ? (
                <ActivityIndicator color={theme.color.text} size="small" />
              ) : (
                <Ionicons name="share-outline" size={18} color={theme.color.text} />
              )}
              <Text style={styles.buttonText}>Share</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    // Nearly opaque rather than a tint: a picture judged against the
    // conversation behind it is a picture you cannot judge.
    backgroundColor: "rgba(0,0,0,0.94)",
    justifyContent: "center",
  },
  closeRow: { position: "absolute", right: theme.gutter, zIndex: 2 },
  closeButton: {
    width: theme.size.control,
    height: theme.size.control,
    borderRadius: theme.radius.pill,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.color.surfaceRaised,
  },
  image: { flex: 1, width: "100%" },
  imageFill: { flex: 1, width: "100%" },
  actions: {
    paddingHorizontal: theme.gutter,
    paddingTop: theme.space(3),
    gap: theme.space(2),
    alignItems: "center",
  },
  feedback: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    textAlign: "center",
  },
  buttonRow: { flexDirection: "row", gap: theme.space(3) },
  button: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    minHeight: theme.size.control,
    paddingHorizontal: theme.space(5),
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.surface,
  },
  primaryButton: { backgroundColor: theme.color.surfaceRaised },
  buttonText: { color: theme.color.text, fontSize: theme.font.body, fontWeight: "600" },
});
