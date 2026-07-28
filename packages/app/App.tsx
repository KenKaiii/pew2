/**
 * pew2 — mobile remote for coding agents.
 *
 * One screen. The provider list, the greeting and the conversation are states
 * of the same surface rather than separate pages, so the composer never moves
 * and a prompt can be typed before an agent is even chosen.
 *
 * The approval sheet is the reason this app exists, so it is a blocking,
 * unmissable surface rather than an inline row that can scroll away.
 */
import { useEffect, useRef, useState } from "react";
import {
  Animated,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "./src/theme";
import { useDaemon, type Provider } from "./src/useDaemon";
import { Orb } from "./src/ui/Orb";
import { Composer } from "./src/ui/Composer";
import { Turn } from "./src/ui/Turn";
import { CircleButton, Pill } from "./src/ui/controls";
import { Sidebar } from "./src/ui/Sidebar";
import { ConfigPicker, summarise, valueName } from "./src/ui/ConfigPicker";
import { useReducedMotion } from "./src/ui/useReducedMotion";

// The simulator shares the host's network, so localhost reaches the daemon.
const DAEMON_URL = "ws://localhost:8787";

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
  const [menuOpen, setMenuOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const scroller = useRef<ScrollView>(null);
  const reduceMotion = useReducedMotion();

  const active: Provider | undefined =
    daemon.providers.find((p) => p.id === daemon.activeProviderId) ??
    daemon.providers.find((p) => p.available);

  const inThread = daemon.turns.length > 0;

  // Model and thinking level are whatever this agent advertised; pew2 keeps no
  // model list of its own.
  const { primary: model, secondary: level } = summarise(daemon.configOptions);

  useEffect(() => {
    if (inThread) scroller.current?.scrollToEnd({ animated: !reduceMotion });
  }, [daemon.turns, daemon.busy, inThread, reduceMotion]);

  const send = () => {
    const text = draft.trim();
    if (!text) return;

    if (daemon.sessionId) {
      daemon.prompt(text);
    } else {
      // No session yet: start one with the chosen agent and let the daemon
      // deliver this prompt as soon as it is ready.
      if (!active?.available) return;
      daemon.start(active.id, text);
    }
    setDraft("");
  };

  return (
    <SafeAreaView style={styles.root} edges={["top", "bottom"]}>
      <StatusBar style="light" />

      <View style={styles.topBar}>
        <View>
          <CircleButton
            label={`Open menu. Daemon ${daemon.status}.`}
            onPress={() => setMenuOpen(true)}
          >
            <Ionicons name="menu" size={20} color={theme.color.text} />
          </CircleButton>
          {/* Connection state as a dot on the menu button: always visible, but
              it never competes with the model name for space. */}
          {daemon.status !== "online" && (
            <View
              style={[
                styles.statusDot,
                {
                  backgroundColor:
                    daemon.status === "connecting"
                      ? theme.color.accent
                      : theme.color.danger,
                },
              ]}
            />
          )}
        </View>

        <Pill
          label={
            model
              ? `Model: ${valueName(model)}${level ? `, ${valueName(level)}` : ""}`
              : (active?.name ?? "No agents")
          }
          onPress={model ? () => setConfigOpen(true) : undefined}
        >
          <Text style={styles.agentName}>
            {valueName(model) ?? active?.name ?? "No agents"}
          </Text>
          {level && <Text style={styles.agentMeta}>{valueName(level)}</Text>}
          {model && (
            <Ionicons
              name="chevron-down"
              size={13}
              color={theme.color.textDim}
              style={styles.pillChevron}
            />
          )}
        </Pill>

        <View style={styles.topBarSpacer} />

        {inThread && (
          <CircleButton label="New conversation" onPress={daemon.leave}>
            <Ionicons name="create-outline" size={18} color={theme.color.text} />
          </CircleButton>
        )}
      </View>

      <KeyboardAvoidingView
        style={styles.body}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
      >
        {inThread ? (
          <ScrollView
            ref={scroller}
            style={styles.thread}
            contentContainerStyle={styles.threadContent}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
          >
            {daemon.turns.map((turn) => (
              <Turn key={turn.id} turn={turn} color={active?.color} />
            ))}
            {daemon.busy && <Working color={active?.color} />}
          </ScrollView>
        ) : (
          <View style={styles.greeting}>
            <Orb color={active?.color} size={56} busy={daemon.busy} />
            <Text style={styles.greetingText}>
              {daemon.status !== "online"
                ? "Connecting to your machine..."
                : active
                  ? `What would you like ${active.name} to do?`
                  : "No agents available on this machine."}
            </Text>
          </View>
        )}

        <View style={styles.dock}>
          <Composer
            value={draft}
            onChangeText={setDraft}
            onSend={send}
            busy={daemon.busy}
            onStop={daemon.cancel}
            editable={daemon.status === "online"}
            placeholder={active ? "Ask me. Task me..." : "Waiting for an agent..."}
          />
        </View>
      </KeyboardAvoidingView>

      <ConfigPicker
        visible={configOpen}
        onClose={() => setConfigOpen(false)}
        options={daemon.configOptions}
        onSelect={daemon.setConfig}
      />

      <Sidebar
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        providers={daemon.providers}
        sessions={daemon.sessions}
        activeProviderId={active?.id}
        activeSessionId={daemon.sessionId}
        onSelectProvider={(id) => {
          daemon.select(id);
          setMenuOpen(false);
        }}
        onOpenSession={(id) => {
          daemon.openSession(id);
          setMenuOpen(false);
        }}
        onNewConversation={() => {
          daemon.leave();
          setMenuOpen(false);
        }}
      />

      {daemon.permission && (
        // Blocking on purpose: an approval must not be scrollable away.
        // accessibilityViewIsModal keeps VoiceOver inside the sheet too.
        <View style={styles.sheetBackdrop} accessibilityViewIsModal>
          <View style={styles.sheet}>
            <Text style={styles.sheetLabel}>APPROVAL NEEDED</Text>
            <Text style={styles.sheetTitle}>{daemon.permission.title}</Text>
            <View style={styles.sheetActions}>
              {daemon.permission.options.map((option) => {
                const deny = /reject|deny|no/i.test(option.optionId);
                // Capture the id now. Another device watching this session can
                // answer first and clear `permission`; dereferencing it inside
                // the handler would then throw.
                const requestId = daemon.permission!.requestId;
                return (
                  <Pressable
                    key={option.optionId}
                    accessibilityRole="button"
                    accessibilityLabel={option.name}
                    onPress={() => daemon.answer(requestId, option.optionId)}
                    style={({ pressed }) => [
                      styles.sheetButton,
                      deny ? styles.sheetDeny : styles.sheetAllow,
                      pressed && styles.sheetPressed,
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

/** Three dots that fade in sequence. Calm, and it costs no layout. */
function Working({ color }: { color?: string }) {
  const one = useRef(new Animated.Value(0.25)).current;
  const two = useRef(new Animated.Value(0.25)).current;
  const three = useRef(new Animated.Value(0.25)).current;
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    if (reduceMotion) return;
    const dots = [one, two, three];
    const loops = dots.map((dot, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 160),
          Animated.timing(dot, { toValue: 1, duration: 320, useNativeDriver: true }),
          Animated.timing(dot, { toValue: 0.25, duration: 320, useNativeDriver: true }),
          Animated.delay((2 - index) * 160),
        ]),
      ),
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [reduceMotion, one, two, three]);

  return (
    // `accessible` groups the orb and dots into one node; without it the label
    // is attached to a container VoiceOver never focuses.
    <View style={styles.workingRow} accessible accessibilityLabel="Agent is working">
      <View style={styles.agentOrbSlot}>
        <Orb color={color} size={22} busy />
      </View>
      <View style={styles.dots}>
        <Animated.View style={[styles.dot, { opacity: one }]} />
        <Animated.View style={[styles.dot, { opacity: two }]} />
        <Animated.View style={[styles.dot, { opacity: three }]} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  body: { flex: 1 },

  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(2),
  },
  topBarSpacer: { flex: 1 },
  // Equal lineHeight on both labels puts them on one optical baseline despite
  // the different font sizes; without it the smaller label rides high.
  agentName: {
    color: theme.color.text,
    fontSize: theme.font.body,
    lineHeight: theme.font.body + 4,
    fontWeight: "600",
  },
  agentMeta: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    lineHeight: theme.font.body + 4,
  },
  // Inset so the chevron never hugs the pill edge.
  pillChevron: { marginLeft: theme.space(0.5) },
  statusDot: {
    position: "absolute",
    top: 0,
    right: 0,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 2,
    borderColor: theme.color.bg,
  },

  thread: { flex: 1 },
  threadContent: {
    paddingHorizontal: theme.space(4),
    paddingTop: theme.space(4),
    paddingBottom: theme.space(2),
    gap: theme.space(5),
  },

  greeting: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: theme.space(5),
    paddingHorizontal: theme.space(10),
  },
  greetingText: {
    color: theme.color.text,
    fontSize: theme.font.greeting,
    lineHeight: theme.line.greeting,
    textAlign: "center",
  },

  // Matches the agent turn's gap and orb size so the working indicator sits on
  // the same rail as the reply that replaces it, with no visible jump.
  workingRow: { flexDirection: "row", gap: theme.space(2.5), alignItems: "center" },
  agentOrbSlot: { height: 22, justifyContent: "center" },
  dots: { flexDirection: "row", gap: theme.space(1.5), alignItems: "center" },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.color.textDim,
  },

  // One consistent gap between the thread and the composer, kept when the
  // keyboard is open so the last message never hides behind the input.
  dock: {
    paddingHorizontal: theme.space(4),
    paddingTop: theme.space(2),
    paddingBottom: theme.space(2),
  },

  sheetBackdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: "rgba(0,0,0,0.72)",
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
    minHeight: theme.size.touch,
    paddingVertical: theme.space(3.5),
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
  },
  sheetAllow: { backgroundColor: theme.color.text },
  sheetDeny: { backgroundColor: theme.color.surface },
  sheetPressed: { opacity: 0.75 },
  sheetButtonText: { color: "#000", fontSize: theme.font.body, fontWeight: "600" },
  sheetDenyText: { color: theme.color.text },
});
