/**
 * pew2 — mobile remote for coding agents.
 *
 * Two screens: pick a provider, then converse with it. The approval sheet is
 * the reason this app exists, so it is a blocking, unmissable surface rather
 * than an inline row that can scroll away.
 */
import { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { theme } from "./src/theme";
import { useDaemon, type Turn } from "./src/useDaemon";

// The simulator shares the host's network, so localhost reaches the daemon.
const DAEMON_URL = "ws://localhost:8787";

const ROLE_LABEL: Record<Turn["role"], string> = {
  user: "You",
  agent: "Agent",
  thought: "Thinking",
  system: "System",
};

function StatusDot({ status }: { status: string }) {
  const color =
    status === "online"
      ? theme.color.success
      : status === "connecting"
        ? theme.color.accent
        : theme.color.danger;
  return <View style={[styles.dot, { backgroundColor: color }]} />;
}

export default function App() {
  return (
    <SafeAreaProvider>
      <Pew2 />
    </SafeAreaProvider>
  );
}

function Pew2() {
  const daemon = useDaemon(DAEMON_URL);
  const [draft, setDraft] = useState("");
  const scroller = useRef<ScrollView>(null);

  useEffect(() => {
    scroller.current?.scrollToEnd({ animated: true });
  }, [daemon.turns, daemon.busy]);

  const send = () => {
    const text = draft.trim();
    if (!text || !daemon.sessionId) return;
    daemon.prompt(text);
    setDraft("");
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <StatusBar style="light" />

      <View style={styles.header}>
        <View style={styles.headerLeft}>
          {daemon.sessionId ? (
            <Pressable onPress={daemon.leave} hitSlop={12}>
              <Text style={styles.back}>‹ Agents</Text>
            </Pressable>
          ) : (
            <Text style={styles.title}>pew2</Text>
          )}
        </View>
        <View style={styles.headerRight}>
          <StatusDot status={daemon.status} />
          <Text style={styles.statusText}>{daemon.status}</Text>
        </View>
      </View>

      {!daemon.sessionId ? (
        <ScrollView contentContainerStyle={styles.list}>
          <Text style={styles.sectionLabel}>AGENTS ON THIS MACHINE</Text>

          {daemon.providers.length === 0 && (
            <Text style={styles.empty}>
              {daemon.status === "online"
                ? "No providers found."
                : "Waiting for the daemon…"}
            </Text>
          )}

          {daemon.providers.map((provider) => (
            <Pressable
              key={provider.id}
              disabled={!provider.available}
              onPress={() => daemon.start(provider.id)}
              style={({ pressed }) => [
                styles.card,
                pressed && styles.cardPressed,
                !provider.available && styles.cardDisabled,
              ]}
            >
              <View
                style={[
                  styles.avatar,
                  { backgroundColor: provider.color ?? theme.color.accent },
                ]}
              >
                <Text style={styles.avatarText}>
                  {provider.name.charAt(0).toUpperCase()}
                </Text>
              </View>
              <View style={styles.cardBody}>
                <Text style={styles.cardTitle}>{provider.name}</Text>
                <Text style={styles.cardDesc} numberOfLines={2}>
                  {provider.unavailableReason ?? provider.description}
                </Text>
              </View>
            </Pressable>
          ))}
        </ScrollView>
      ) : (
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          keyboardVerticalOffset={8}
        >
          <ScrollView ref={scroller} contentContainerStyle={styles.thread}>
            {daemon.turns.map((turn) => (
              <View
                key={turn.id}
                style={[styles.turn, turn.role === "user" && styles.turnUser]}
              >
                <Text style={[styles.turnRole, styles[`role_${turn.role}`]]}>
                  {ROLE_LABEL[turn.role]}
                </Text>
                <Text
                  style={[
                    styles.turnText,
                    turn.role === "thought" && styles.turnThought,
                    turn.role === "system" && styles.turnSystem,
                  ]}
                >
                  {turn.text.trim()}
                </Text>
              </View>
            ))}

            {daemon.busy && (
              <View style={styles.working}>
                <ActivityIndicator size="small" color={theme.color.textDim} />
                <Text style={styles.workingText}>working…</Text>
              </View>
            )}
          </ScrollView>

          <View style={styles.composer}>
            <TextInput
              style={styles.input}
              value={draft}
              onChangeText={setDraft}
              placeholder="Message the agent…"
              placeholderTextColor={theme.color.textFaint}
              multiline
              onSubmitEditing={send}
              returnKeyType="send"
            />
            <Pressable
              onPress={send}
              disabled={!draft.trim()}
              style={({ pressed }) => [
                styles.sendButton,
                !draft.trim() && styles.sendDisabled,
                pressed && styles.cardPressed,
              ]}
            >
              <Text style={styles.sendText}>↑</Text>
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      )}

      {daemon.permission && (
        <View style={styles.sheetBackdrop}>
          <View style={styles.sheet}>
            <Text style={styles.sheetLabel}>APPROVAL NEEDED</Text>
            <Text style={styles.sheetTitle}>{daemon.permission.title}</Text>
            <View style={styles.sheetActions}>
              {daemon.permission.options.map((option) => {
                const deny = /reject|deny|no/i.test(option.optionId);
                return (
                  <Pressable
                    key={option.optionId}
                    onPress={() =>
                      daemon.answer(daemon.permission!.requestId, option.optionId)
                    }
                    style={({ pressed }) => [
                      styles.sheetButton,
                      deny ? styles.sheetDeny : styles.sheetAllow,
                      pressed && styles.cardPressed,
                    ]}
                  >
                    <Text style={[styles.sheetButtonText, deny && styles.sheetDenyText]}>
                      {option.name}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        </View>
      )}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  flex: { flex: 1 },

  header: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(3),
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: theme.color.border,
  },
  headerLeft: { flex: 1 },
  headerRight: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  title: { color: theme.color.text, fontSize: theme.font.title, fontWeight: "700" },
  back: { color: theme.color.accent, fontSize: theme.font.body },
  dot: { width: 8, height: 8, borderRadius: 4 },
  statusText: { color: theme.color.textDim, fontSize: theme.font.tiny },

  list: { padding: theme.space(4), gap: theme.space(3) },
  sectionLabel: {
    color: theme.color.textFaint,
    fontSize: theme.font.tiny,
    letterSpacing: 1,
    marginBottom: theme.space(1),
  },
  empty: {
    color: theme.color.textDim,
    fontSize: theme.font.body,
    paddingVertical: theme.space(6),
  },

  card: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(3),
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    padding: theme.space(4),
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
  },
  cardPressed: { opacity: 0.65 },
  cardDisabled: { opacity: 0.45 },
  avatar: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: { color: "#fff", fontSize: theme.font.title, fontWeight: "700" },
  cardBody: { flex: 1, gap: 2 },
  cardTitle: { color: theme.color.text, fontSize: theme.font.body, fontWeight: "600" },
  cardDesc: { color: theme.color.textDim, fontSize: theme.font.small, lineHeight: 18 },

  thread: { padding: theme.space(4), gap: theme.space(4) },
  turn: { gap: theme.space(1) },
  turnUser: { alignItems: "flex-end" },
  turnRole: { fontSize: theme.font.tiny, letterSpacing: 0.8, fontWeight: "600" },
  role_user: { color: theme.color.textFaint },
  role_agent: { color: theme.color.accent },
  role_thought: { color: theme.color.thought },
  role_system: { color: theme.color.danger },
  turnText: { color: theme.color.text, fontSize: theme.font.body, lineHeight: 22 },
  turnThought: { color: theme.color.textDim, fontStyle: "italic" },
  turnSystem: { color: theme.color.danger, fontSize: theme.font.small },

  working: { flexDirection: "row", alignItems: "center", gap: theme.space(2) },
  workingText: { color: theme.color.textDim, fontSize: theme.font.small },

  composer: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: theme.space(2),
    padding: theme.space(3),
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: theme.color.border,
  },
  input: {
    flex: 1,
    maxHeight: 120,
    color: theme.color.text,
    fontSize: theme.font.body,
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2.5),
  },
  sendButton: {
    width: 38,
    height: 38,
    borderRadius: 19,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.color.accent,
  },
  sendDisabled: { backgroundColor: theme.color.border },
  sendText: { color: "#fff", fontSize: theme.font.title, fontWeight: "700" },

  sheetBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.6)",
    justifyContent: "flex-end",
  },
  sheet: {
    backgroundColor: theme.color.surfaceRaised,
    borderTopLeftRadius: theme.radius.lg,
    borderTopRightRadius: theme.radius.lg,
    padding: theme.space(5),
    gap: theme.space(3),
  },
  sheetLabel: { color: theme.color.accent, fontSize: theme.font.tiny, letterSpacing: 1 },
  sheetTitle: { color: theme.color.text, fontSize: theme.font.title, fontWeight: "600" },
  sheetActions: { flexDirection: "row", gap: theme.space(3), marginTop: theme.space(2) },
  sheetButton: {
    flex: 1,
    paddingVertical: theme.space(3.5),
    borderRadius: theme.radius.md,
    alignItems: "center",
  },
  sheetAllow: { backgroundColor: theme.color.accent },
  sheetDeny: {
    backgroundColor: theme.color.surface,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: theme.color.border,
  },
  sheetButtonText: { color: "#fff", fontSize: theme.font.body, fontWeight: "600" },
  sheetDenyText: { color: theme.color.textDim },
});
