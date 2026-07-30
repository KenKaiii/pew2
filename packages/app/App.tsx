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
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Keyboard,
  LayoutAnimation,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "./src/theme";
import { useDaemon, type Provider } from "./src/useDaemon";
import { Orb } from "./src/ui/Orb";
import { Composer } from "./src/ui/Composer";
import { Turn } from "./src/ui/Turn";
import { CircleButton, Pill } from "./src/ui/controls";
import { haptics } from "./src/ui/haptics";
import { Sidebar, DRAWER_WIDTH } from "./src/ui/Sidebar";
import { ConfigPicker, summarise, valueName } from "./src/ui/ConfigPicker";
import { useReducedMotion } from "./src/ui/useReducedMotion";
import { ThreadSkeleton } from "./src/ui/Skeleton";
import { ProgressiveBlur } from "./src/ui/ProgressiveBlur";
import { withLayoutX, type PillX } from "./src/ui/pillAnchor";
import { PairingScreen } from "./src/ui/PairingScreen";
import { LaunchScreen } from "./src/ui/LaunchScreen";
import { clearPairing, loadPairing, savePairing, type Pairing } from "./src/pairing";
import {
  useFonts,
  BitcountPropSingle_400Regular,
  BitcountPropSingle_600SemiBold,
  BitcountPropSingle_700Bold,
} from "@expo-google-fonts/bitcount-prop-single";

export default function App() {
  const [fontsLoaded] = useFonts({
    BitcountPropSingle_400Regular,
    BitcountPropSingle_600SemiBold,
    BitcountPropSingle_700Bold,
  });

  // Hold on the canvas colour rather than rendering with the fallback face:
  // the two have different metrics, so titles would visibly reflow the moment
  // the display font arrives.
  if (!fontsLoaded) {
    return (
      <SafeAreaProvider>
        <View style={{ flex: 1, backgroundColor: theme.color.bg }} />
      </SafeAreaProvider>
    );
  }

  return (
    <SafeAreaProvider>
      <Root />
    </SafeAreaProvider>
  );
}

/**
 * Pairing gate.
 *
 * The daemon's address is a secret held in the keychain, so it is not known
 * until an async read completes. Rendering the conversation before then would
 * open a socket to nowhere, so this holds a neutral screen for the frame it
 * takes, and shows the pairing screen when nothing is stored.
 */
function Root() {
  const [pairing, setPairing] = useState<Pairing | null>(null);
  const [checked, setChecked] = useState(false);
  // Whether the user has moved past the launch screen. Not persisted: it only
  // exists between opening the app and pairing, and a stored pairing skips it
  // entirely.
  const [connecting, setConnecting] = useState(false);

  useEffect(() => {
    let alive = true;
    loadPairing().then((stored) => {
      if (!alive) return;
      setPairing(stored);
      setChecked(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const pair = useCallback((next: Pairing) => {
    // Connect regardless of whether the keychain accepted it. A locked or
    // unavailable keychain costs the user a re-pair next launch; blocking on it
    // would strand them on this screen with a spinner and no way forward.
    savePairing(next)
      .catch(() => {})
      .then(() => setPairing(next));
  }, []);

  const unpair = useCallback(() => {
    // Same reasoning inverted: forget it locally even if the delete failed, or
    // "Disconnect" would appear to do nothing.
    clearPairing()
      .catch(() => {})
      .then(() => {
        setPairing(null);
        // Back to the launch screen rather than straight to the form, so
        // disconnecting lands somewhere deliberate.
        setConnecting(false);
      });
  }, []);

  if (!checked) return <View style={{ flex: 1, backgroundColor: theme.color.bg }} />;
  // A paired device never sees the launch screen: it has a machine already, and
  // an extra tap on every cold start would be pure friction.
  if (pairing) return <Pew2 pairing={pairing} onUnpair={unpair} />;
  if (!connecting) return <LaunchScreen onConnect={() => setConnecting(true)} />;
  return <PairingScreen onPaired={pair} onBack={() => setConnecting(false)} />;
}

function Pew2({ pairing, onUnpair }: { pairing: Pairing; onUnpair: () => void }) {
  // The relay identifies devices by this, and it must match the id baked into
  // the stored pairing URL or the two look like different clients.
  const daemon = useDaemon(pairing.url, pairing.deviceId);
  const [draft, setDraft] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  // Which pill's menu is open, and where that pill sits, so the menu opens
  // under it instead of always at the gutter.
  const [picker, setPicker] = useState<"model" | "mode" | null>(null);
  // Measured so the thread's top inset always matches the real nav height.
  const [navHeight, setNavHeight] = useState(0);
  // The composer floats, so the thread's bottom inset and the frosted zone
  // track its measured height. iOS overlays the keyboard, so the composer
  // follows it manually; Android's adjustResize already moves the viewport.
  const [dockHeight, setDockHeight] = useState(0);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  useEffect(() => {
    if (Platform.OS !== "ios") return;

    const onShow = Keyboard.addListener("keyboardWillShow", (e) => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setKeyboardHeight(e.endCoordinates.height);
    });
    const onHide = Keyboard.addListener("keyboardWillHide", () => {
      LayoutAnimation.configureNext(LayoutAnimation.Presets.easeInEaseOut);
      setKeyboardHeight(0);
    });
    return () => {
      onShow.remove();
      onHide.remove();
    };
  }, []);
  // Absolutely-positioned overlays ignore SafeAreaView's padding, so they
  // must be offset by the inset themselves or they slide under the clock.
  const insets = useSafeAreaInsets();
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

  // Feedback for things that happen on their own, rather than because a finger
  // touched the screen. This is the point of a remote control: the agent runs
  // for minutes on another machine, and the phone is usually in a pocket. Each
  // effect compares against the previous value so nothing fires on mount.

  // A turn landed. The single most useful pulse in the app.
  const wasBusy = useRef(false);
  useEffect(() => {
    const finished = wasBusy.current && !daemon.busy;
    wasBusy.current = daemon.busy;
    if (!finished) return;
    // A turn that ended in an error already pulsed as a failure below; a success
    // buzz on top of it would contradict what the screen says.
    const last = daemon.turns[daemon.turns.length - 1];
    if (last?.role !== "system") haptics.finished();
  }, [daemon.busy, daemon.turns]);

  // The agent is blocked on an approval and cannot continue without one.
  const lastPermissionId = useRef<string | undefined>(undefined);
  useEffect(() => {
    const requestId = daemon.permission?.requestId;
    if (requestId && requestId !== lastPermissionId.current) haptics.attention();
    lastPermissionId.current = requestId;
  }, [daemon.permission]);

  // Something failed. Keyed by role as well as id, because a duplicated error is
  // promoted in place rather than appended, which leaves the id unchanged.
  const lastTurnKey = useRef<string | undefined>(undefined);
  useEffect(() => {
    const last = daemon.turns[daemon.turns.length - 1];
    const key = last && `${last.id}:${last.role}`;
    const changed = key !== undefined && key !== lastTurnKey.current;
    // Seed on first render so an error already on screen from a replayed
    // session does not buzz every time the component mounts.
    const seeded = lastTurnKey.current !== undefined;
    lastTurnKey.current = key;
    if (seeded && changed && last?.role === "system") haptics.failed();
  }, [daemon.turns]);

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
        historyLoading={daemon.loadingSessions}
        machineLabel={pairing.label}
        machineRemote={pairing.remote}
        onUnpair={onUnpair}
      />

      {/* The conversation pane. Slides right to reveal the drawer beneath. */}
      <Animated.View style={[styles.pane, { transform: [{ translateX: slideX }] }]}>
      {/* Full-bleed: the thread runs behind the status bar too, and the
          ProgressiveBlur covers that region, so content dissolves all the way
          to the top edge instead of meeting a solid band under the clock. */}
      <SafeAreaView style={styles.paneInner} edges={["bottom"]}>

      {/* Absolute over the thread: messages scroll beneath the nav and
          dissolve into the ProgressiveBlur fade instead of hitting a panel
          edge, so the conversation keeps the full screen height. */}
      <View
        style={[styles.topBar, styles.topBarOverlay, { top: insets.top }]}
        onLayout={(e) => setNavHeight(e.nativeEvent.layout.height)}
      >
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

      {/* Frosted cover for the nav zone only — it ends exactly at the nav's
          bottom edge and touches nothing below it. pointerEvents-none, so it
          never swallows a tap on a message or a pill. */}
      {navHeight > 0 && (
        <ProgressiveBlur
          // From the very top edge to the nav's bottom edge. No tail.
          height={insets.top + navHeight}
          style={styles.navFade}
        />
      )}

      <View style={styles.body}>
        {inThread ? (
          <ScrollView
            ref={scroller}
            style={styles.thread}
            contentContainerStyle={[
              styles.threadContent,
              {
                // Clear the status bar plus the nav before the first message,
                // and the composer (plus an open keyboard) after the last.
                paddingTop: insets.top + (navHeight || theme.space(12)) + theme.space(2),
                paddingBottom: dockHeight + keyboardHeight + theme.space(2),
              },
            ]}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
          >
            {daemon.turns.map((turn) => (
              <Turn key={turn.id} turn={turn} />
            ))}
            {daemon.busy && <Working />}
          </ScrollView>
        ) : daemon.busy ? (
          // Resuming a conversation streams its history back from the agent,
          // which takes a moment. Blocks shaped like the coming messages are a
          // better wait than a greeting that reads as "nothing here yet".
          <ThreadSkeleton />
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

        {/* The composer floats over the thread, and its frosted zone is
            contained to exactly its own height — the mirror of the nav. */}
        {dockHeight > 0 && (
          <ProgressiveBlur
            edge="bottom"
            height={dockHeight}
            style={[styles.dockCover, { bottom: keyboardHeight }]}
          />
        )}
        <View
          style={[
            styles.dock,
            styles.dockOverlay,
            {
              bottom: keyboardHeight,
              // SafeAreaView already reserves the home-indicator inset.
              paddingBottom: theme.space(2),
            },
          ]}
          onLayout={(e) => setDockHeight(e.nativeEvent.layout.height)}
        >
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
      </View>

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
          onPress={() => {
            haptics.tap();
            setMenuOpen(false);
          }}
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
                    // Approving hands real capability to the agent, so the two
                    // answers must not feel identical under the thumb.
                    onPress={() => {
                      if (deny) haptics.warned();
                      else haptics.sent();
                      daemon.answer(requestId, option.optionId);
                    }}
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
  topBarOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    zIndex: 3,
  },
  navFade: { zIndex: 2 },
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
    fontFamily: theme.display.regular,
    fontSize: theme.font.greeting,
    lineHeight: theme.line.greeting,
    letterSpacing: 0.3,
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
  dockOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 3,
  },
  dockCover: { zIndex: 2 },

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
