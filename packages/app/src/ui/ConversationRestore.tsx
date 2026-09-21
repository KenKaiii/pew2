import { Pressable, StyleSheet, Text, View } from "react-native";
import { Skeleton } from "./Skeleton";
import { theme } from "../theme";
import type { RestorePresentation } from "../restoreState";

export interface ConversationRestoreProps {
  title: string;
  state: RestorePresentation;
  error?: string;
  onRetry: () => void;
}
export function ConversationRestore({ title, state, error, onRetry }: ConversationRestoreProps) {
  if (!state) return null;
  const message = state === "failed" ? error ?? "This conversation could not be opened."
    : state === "reconnecting" ? "Reconnecting to your computer…"
      : state === "empty" ? "No messages in this conversation." : "Opening conversation…";
  return <View style={styles.root}>
    <Text style={styles.title} accessibilityRole="header">{title}</Text>
    <Text style={styles.message} accessibilityRole={state === "failed" ? "alert" : "text"}>{message}</Text>
    {state === "loading" && <View accessible={false} accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={styles.skeleton}>
      <Skeleton style={{ height: 16, width: "88%" }} />
      <Skeleton style={{ height: 16, width: "64%" }} />
    </View>}
    {state === "failed" && <Pressable accessibilityRole="button" accessibilityLabel={`Retry opening ${title}`} onPress={onRetry} style={({ pressed }) => [styles.retry, pressed && { backgroundColor: theme.color.surfacePressed }]}>
      <Text style={styles.retryText}>Retry</Text>
    </Pressable>}
  </View>;
}
const styles = StyleSheet.create({
  root: { paddingHorizontal: theme.gutter, paddingVertical: theme.sectionGap, gap: theme.space(3) },
  title: { color: theme.color.text, fontSize: theme.font.body, lineHeight: theme.line.body },
  message: { color: theme.color.textDim, fontSize: theme.font.small, lineHeight: 20 },
  skeleton: { gap: theme.space(3) },
  retry: { alignSelf: "flex-start", minHeight: 44, justifyContent: "center", paddingHorizontal: theme.space(4), backgroundColor: theme.color.surfaceRaised, borderRadius: theme.radius.md },
  retryText: { color: theme.color.text, fontSize: theme.font.small, lineHeight: 17 },
});
