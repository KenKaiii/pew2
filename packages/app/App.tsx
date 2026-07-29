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
  Easing,
  Keyboard,
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
import { Sidebar, DRAWER_WIDTH } from "./src/ui/Sidebar";
import { ConfigPicker, summarise, valueName } from "./src/ui/ConfigPicker";
import { useReducedMotion } from "./src/ui/useReducedMotion";
import { withLayoutX, type PillX } from "./src/ui/pillAnchor";

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
  // Which pill's menu is open, and where that pill sits, so the menu opens
  // under it instead of always at the gutter.
  const [picker, setPicker] = useState<"model" | "mode" | null>(null);
  const [pillX, setPillX] = useState<PillX>({
    model: theme.gutter,
    mode: theme.gutter,
  });
  const scroller = useRef<ScrollView>(null);
  const reduceMotion = useReducedMotion();
  const drawer = useRef(new Animated.Value(0)).current;

  const active: Provider | undefined =
    daemon.providers.find((p) => p.id === daemon.activeProviderId) ??
    daemon.providers.find((p) => p.available);

  const inThread = daemon.turns.length > 0;

  // Model, permission mode and thinking level are whatever this agent
  // advertised; pew2 keeps no model list of its own. Mode gets its own pill:
  // folding it into the model pill would hide whichever one lost.
  const { model, mode: modeOption, level } = summarise(daemon.configOptions);
  // Never let one selector drive two pills.
  const mode = modeOption && modeOption.id !== model?.id ? modeOption : undefined;

  useEffect(() => {
    if (inThread) scroller.current?.scrollToEnd({ animated: !reduceMotion });
  }, [daemon.turns, daemon.busy, inThread, reduceMotion]);

  // Push, not overlay: the conversation slides right to uncover the drawer, so
  // both surfaces stay part of one layout instead of becoming a modal layer.
  useEffect(() => {
    const animation = Animated.timing(drawer, {
      toValue: menuOpen ? 1 : 0,
      duration: reduceMotion ? 0 : 280,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [menuOpen, reduceMotion, drawer]);

  // Translate only. The conversation keeps its exact size as it moves, so no
  // text reflows or resamples mid-animation.
  const slideX = drawer.interpolate({
    inputRange: [0, 1],
    outputRange: [0, DRAWER_WIDTH],
  });

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
    <View style={styles.root}>
      <StatusBar style="light" />

      <Sidebar
        open={menuOpen}
        providers={daemon.providers}
        sessions={daemon.sessions}
        activeProviderId={active?.id}
        activeSessionId={daemon.sessionId}
        // Selecting an app refilters the history in place. The drawer stays
        // open so you can pick a conversation from that app straight after —
        // closing here would make choosing an app cost two trips.
        onSelectProvider={daemon.select}
        onOpenSession={(id) => {
          daemon.openSession(id);
          setMenuOpen(false);
        }}
        onNewConversation={() => {
          daemon.leave();
          setMenuOpen(false);
        }}
      />

      {/* The conversation pane. Slides right to reveal the drawer beneath. */}
      <Animated.View style={[styles.pane, { transform: [{ translateX: slideX }] }]}>
      <SafeAreaView style={styles.paneInner} edges={["top", "bottom"]}>

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

        {/* No agent-name pill. Which app is connected is already the drawer's
            job, and repeating it here only stole width from the selectors,
            which are the sole reason the top bar is interactive. */}
        {model && (
          <View
            style={styles.selectorPill}
            onLayout={(e) => setPillX(withLayoutX(e, "model"))}
          >
            <Pill
              label={`Model: ${valueName(model)}${level ? `, ${valueName(level)}` : ""}`}
              onPress={() => setPicker("model")}
            >
              {/* The thinking level is not shown here. It lives in this pill's
                  own menu, and squeezing both names into one pill truncated
                  each to a couple of letters. */}
              <Text style={styles.selectorValue} numberOfLines={1}>
                {valueName(model)}
              </Text>
              <Ionicons
                name="chevron-down"
                size={13}
                color={theme.color.textDim}
                style={styles.pillChevron}
              />
            </Pill>
          </View>
        )}

        {mode && (
          <View
            style={styles.selectorPill}
            onLayout={(e) => setPillX(withLayoutX(e, "mode"))}
          >
            <Pill
              label={`${mode.name}: ${valueName(mode)}`}
              onPress={() => setPicker("mode")}
            >
              <Text style={styles.selectorValue} numberOfLines={1}>
                {valueName(mode)}
              </Text>
              <Ionicons
                name="chevron-down"
                size={13}
                color={theme.color.textDim}
                style={styles.pillChevron}
              />
            </Pill>
          </View>
        )}

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
              <Turn key={turn.id} turn={turn} />
            ))}
            {daemon.busy && <Working />}
          </ScrollView>
        ) : (
          // Tapping the empty state dismisses the keyboard, which collapses the
          // composer. Without this the greeting is inert and the only way out of
          // the expanded state is the keyboard's own dismiss control.
          <Pressable
            style={styles.greeting}
            accessibilityRole="button"
            accessibilityLabel="Dismiss keyboard"
            onPress={Keyboard.dismiss}
          >
            <Orb color={active?.color} size={56} busy={daemon.busy} />
            <Text style={styles.greetingText}>
              {daemon.status !== "online"
                ? "Connecting to your machine..."
                : active
                  ? `What would you like ${active.name} to do?`
                  : "No agents available on this machine."}
            </Text>
          </Pressable>
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

      {/* One picker, pointed at whichever pill opened it. The mode selector is
          excluded from the model menu so each pill owns exactly one list. */}
      <ConfigPicker
        visible={picker !== null}
        onClose={() => setPicker(null)}
        anchorX={picker === "mode" ? pillX.mode : pillX.model}
        options={
          picker === "mode"
            ? mode
              ? [mode]
              : []
            : daemon.configOptions.filter((option) => option.id !== mode?.id)
        }
        onSelect={daemon.setConfig}
      />

      {/* While the drawer is open the pane itself is the way back: tapping
          anywhere on it closes, which matches the push metaphor better than a
          separate dimming layer would. */}
      {menuOpen && (
        <Pressable
          style={StyleSheet.absoluteFill}
          accessibilityRole="button"
          accessibilityLabel="Close menu"
          onPress={() => setMenuOpen(false)}
        />
      )}

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
      </Animated.View>
    </View>
  );
}

/** Three dots that fade in sequence. Calm, and it costs no layout. */
function Working() {
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
    // `accessible` groups the dots into one node; without it the label is
    // attached to a container VoiceOver never focuses.
    <View style={styles.workingRow} accessible accessibilityLabel="Agent is working">
      <Animated.View style={[styles.dot, { opacity: one }]} />
      <Animated.View style={[styles.dot, { opacity: two }]} />
      <Animated.View style={[styles.dot, { opacity: three }]} />
    </View>
  );
}

const styles = StyleSheet.create({
  // Drawer colour, so the strip behind the sliding pane matches it.
  root: { flex: 1, backgroundColor: theme.color.drawer },
  // Rounded on all corners: once it slides it is a card over the drawer, and
  // the curve is what makes the two planes legible.
  pane: {
    flex: 1,
    backgroundColor: theme.color.bg,
    borderRadius: theme.radius.pane,
    overflow: "hidden",
    // Must sit above the drawer, which is absolutely positioned and would
    // otherwise paint over this pane and swallow its touches.
    zIndex: 1,
    // A cast shadow is what stops the two dark planes merging into one at the
    // seam once the pane slides clear.
    shadowColor: "#000",
    shadowOpacity: 0.5,
    shadowRadius: 24,
    shadowOffset: { width: -8, height: 0 },
    elevation: 16,
  },
  paneInner: { flex: 1 },
  body: { flex: 1 },

  topBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    // Shares theme.gutter and theme.headerInset with the drawer header, so the
    // hamburger and the "Connected Apps" title it reveals sit on one rail and
    // one baseline.
    paddingHorizontal: theme.gutter,
    paddingVertical: theme.headerInset,
  },
  topBarSpacer: { flex: 1 },
  // Pills hug their text, but no single pill may take the row. flexShrink
  // alone shrinks proportionally, which left the model pill wide and starved
  // the mode pill to "A…"; the cap bounds the greedy one instead.
  selectorPill: { flexShrink: 1, minWidth: 0, maxWidth: "42%" },
  selectorValue: {
    flexShrink: 1,
    color: theme.color.text,
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
    paddingHorizontal: theme.gutter,
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

  // Sits on the same left rail as the agent text that replaces it, so the
  // reply does not jump horizontally when streaming begins.
  workingRow: {
    flexDirection: "row",
    gap: theme.space(1.5),
    alignItems: "center",
    height: theme.line.body,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: theme.color.textDim,
  },

  // One consistent gap between the thread and the composer, kept when the
  // keyboard is open so the last message never hides behind the input.
  dock: {
    paddingHorizontal: theme.gutter,
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
