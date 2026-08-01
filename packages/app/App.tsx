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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Animated,
  Easing,
  Keyboard,
  PanResponder,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { SafeAreaProvider, SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { KeyboardProvider, useKeyboardHandler } from "react-native-keyboard-controller";
import Reanimated, {
  useAnimatedStyle,
  useSharedValue,
} from "react-native-reanimated";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "./src/theme";
import { isDenyApprovalOption, selectApprovalOptions } from "./src/approvalOptions";
import { useDaemon, type Provider } from "./src/useDaemon";
import { Orb } from "./src/ui/Orb";
import { Composer, type ComposerHandle } from "./src/ui/Composer";
import { ChatThread, type ChatThreadRef } from "./src/ui/ChatThread";
import { ImageResolverProvider } from "./src/ui/ChatImage";
import { CommandSheet } from "./src/ui/CommandSheet";
import { applyCommand, type SlashCommand } from "./src/slashCommands";
import { CircleButton, Pill, touchSlop } from "./src/ui/controls";
import { haptics } from "./src/ui/haptics";
import { Sidebar, DRAWER_WIDTH } from "./src/ui/Sidebar";
import { ConfigPicker, summarise, valueName } from "./src/ui/ConfigPicker";
import { useReducedMotion } from "./src/ui/useReducedMotion";
import { ProgressiveBlur } from "./src/ui/ProgressiveBlur";
import { Glass } from "./src/ui/Glass";
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
    // Every keyboard-driven element in this app moves on the keyboard's own
    // frame-by-frame position rather than a JS animation started alongside it.
    // Coordinating two animation systems is what made the thread land twice.
    <KeyboardProvider>
      <SafeAreaProvider>
        <Root />
      </SafeAreaProvider>
    </KeyboardProvider>
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
    // the confirmed "Forget" action would appear to do nothing.
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

/**
 * The mark's diameter on an empty conversation, with nothing to compete with.
 *
 * Large enough to be the subject of the screen rather than an icon above a
 * sentence, and it reaches the densest grid the geometry offers — so the
 * drifting light has the most cells to travel across.
 */
const ORB_REST_SIZE = 96;

/** What it settles back to once the keyboard is up, as a fraction of that. */
const ORB_SETTLED_SCALE = 56 / ORB_REST_SIZE;

/**
 * Raises the thread and the composer by exactly the visible keyboard's height,
 * and returns a second style for content that is centred rather than
 * bottom-anchored.
 *
 * Written from a worklet on every frame of the keyboard's own animation, so the
 * two move in perfect step. No JS re-render can land halfway through and move
 * things a second time.
 *
 * A transform, deliberately, not a height. The thread is a recycling list, and
 * `RecyclerView` answers any container resize with a full layout pass in JS — so
 * shortening the pane per frame queued sixty of them across the keyboard's
 * animation, which is the stutter. Translating moves the same pixels on the UI
 * thread and lays out nothing. This is the shape `KeyboardChatScrollView` uses;
 * that component would do it for us, but it landed in
 * react-native-keyboard-controller 1.21 and this app is on 1.18.
 *
 * Cross-platform by construction rather than by branch: `useKeyboardHandler`
 * calls the library's `useResizeMode`, which sets Android to `adjustResize`, and
 * `KeyboardProvider` puts it in edge-to-edge — a pairing that stops Android
 * resizing the window at all. So on both platforms nothing but this transform
 * moves, and neither needs a `softwareKeyboardLayoutMode` in app.json.
 *
 * The keyboard is measured from the physical screen edge, so the home-indicator
 * clearance the dock keeps is handed back while it is open, and the composer
 * keeps the same gap above either boundary.
 *
 * @returns `pane` for bottom-anchored content, `centred` to cancel half of it,
 *   `settled` for content that gives up room while the keyboard is open.
 */
function useKeyboardLift(bottomInset: number) {
  const height = useSharedValue(0);
  const progress = useSharedValue(0);

  useKeyboardHandler(
    {
      onMove: (event) => {
        "worklet";
        height.value = Math.max(0, event.height - bottomInset * event.progress);
        progress.value = event.progress;
      },
      onEnd: (event) => {
        "worklet";
        height.value = Math.max(0, event.height - bottomInset * event.progress);
        progress.value = event.progress;
      },
    },
    [bottomInset],
  );

  const pane = useAnimatedStyle(() => ({
    transform: [{ translateY: -height.value }],
  }));

  // The empty state is centred in the pane rather than anchored to its bottom
  // edge, so the full lift would carry it up by a whole keyboard — twice what
  // re-centring needs, and far enough to push the greeting under the nav. Half
  // the lift keeps it centred in what is left of the screen.
  const centred = useAnimatedStyle(() => ({
    transform: [{ translateY: height.value / 2 }],
  }));

  // At rest the mark is the screen: nothing else is there, so it should own it.
  // Once you start typing the screen belongs to the sentence you are writing,
  // and the mark steps back to being an emblem above it.
  //
  // A scale, not a smaller `size`: the grid resolution is chosen from the size,
  // so animating that would rebuild the whole dot matrix mid-keyboard — exactly
  // the per-frame relayout the pane transform exists to avoid. Reserved layout
  // stays at full size for the same reason: nothing reflows on the keyboard's
  // clock, and the greeting keeps one still centre to scale about.
  //
  // Held in a local because a worklet runs in its own runtime, where this
  // file's module scope does not exist — only closed-over values cross over.
  const shrinkBy = 1 - ORB_SETTLED_SCALE;
  const settled = useAnimatedStyle(() => ({
    transform: [{ scale: 1 - shrinkBy * progress.value }],
  }));

  return { pane, centred, settled };
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
  const [commandsOpen, setCommandsOpen] = useState(false);
  const composer = useRef<ComposerHandle>(null);
  /** The keyboard is up, so the composer owns the screen. */
  const [typing, setTyping] = useState(false);
  // Measured so the thread's top inset always matches the real nav height.
  const [navHeight, setNavHeight] = useState(0);
  // The thread's bottom inset and frosted zone track the dock's measured height.
  const [dockHeight, setDockHeight] = useState(0);
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardLift(insets.bottom);
  const scroller = useRef<ChatThreadRef>(null);
  // Identifies the conversation on screen for remount purposes. Every other way
  // of changing conversations empties the transcript first, which unmounts the
  // list on its own; only picking one drawer entry while another is open swaps
  // the turns in place.
  const [threadKey, setThreadKey] = useState("new");
  // Drives the scroll-to-latest control below.
  const [atBottom, setAtBottom] = useState(true);
  const jumpOpacity = useRef(new Animated.Value(0)).current;

  const [pillX, setPillX] = useState<PillX>({
    model: theme.gutter,
    mode: theme.gutter,
  });
  const reduceMotion = useReducedMotion();
  const drawer = useRef(new Animated.Value(0)).current;

  const active: Provider | undefined =
    daemon.providers.find((p) => p.id === daemon.activeProviderId) ??
    daemon.providers.find((p) => p.available);

  const inThread = daemon.turns.length > 0;

  // Where the reading area begins and ends: under the nav, and above the
  // composer. Both fall back to the resting height of the thing they clear,
  // because `onLayout` only reports after the first paint — and a zero here is
  // a first message rendered hard against the composer, corrected a frame later.
  const threadTop = insets.top + (navHeight || theme.space(12)) + theme.space(2);
  // Mirrors `styles.dock`: the composer at rest, plus that view's own padding.
  const restingDockHeight =
    theme.size.composerCollapsed + theme.space(2) + (insets.bottom + theme.space(2));
  const threadBottom = (dockHeight || restingDockHeight) + theme.space(2);
  // Only until the answer itself starts arriving. The dots occupy exactly one
  // body line at the same offset as the agent's first line, so text replacing
  // them lands where they were and the transcript never shifts — whereas dots
  // held below a growing reply would push it for the whole turn.
  const newest = daemon.turns[daemon.turns.length - 1];
  const answering =
    (newest?.role === "agent" || newest?.role === "thought") && newest.text.trim().length > 0;
  const working = daemon.busy && !daemon.loadingSession && !answering;

  useEffect(() => {
    // Every transcript opens on its newest message, so it starts at the bottom
    // regardless of where the previous one had been scrolled to. Keyed on the
    // thread's own identity rather than `daemon.sessionId`, which stays
    // undefined across a switch between two unresumed conversations and would
    // leave the jump-to-latest chip showing over a thread already at its end.
    setAtBottom(true);
  }, [threadKey, inThread]);

  // Model, permission mode and thinking level are whatever this agent
  // advertised; pew2 keeps no model list of its own. Mode gets its own pill:
  // folding it into the model pill would hide whichever one lost.
  const { model, mode: modeOption, level } = summarise(daemon.configOptions);
  // Never let one selector drive two pills.
  const mode = modeOption && modeOption.id !== model?.id ? modeOption : undefined;

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
    if (requestId && requestId !== lastPermissionId.current) {
      Keyboard.dismiss();
      haptics.attention();
    }
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
  // Shared with the edge gesture, which hands the drawer over mid-drag.
  const settleDrawer = useCallback(
    (open: boolean) =>
      Animated.timing(drawer, {
        toValue: open ? 1 : 0,
        duration: reduceMotion ? 0 : 280,
        easing: Easing.out(Easing.cubic),
        useNativeDriver: true,
      }).start(),
    [drawer, reduceMotion],
  );

  useEffect(() => {
    settleDrawer(menuOpen);
    return () => drawer.stopAnimation();
  }, [menuOpen, settleDrawer, drawer]);

  // Translate only. The conversation keeps its exact size as it moves, so no
  // text reflows or resamples mid-animation.
  const slideX = drawer.interpolate({
    inputRange: [0, 1],
    outputRange: [0, DRAWER_WIDTH],
  });

  useEffect(() => {
    const animation = Animated.timing(jumpOpacity, {
      toValue: atBottom ? 0 : 1,
      duration: reduceMotion ? 0 : theme.motion.fast,
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [atBottom, reduceMotion, jumpOpacity]);

  // The drawer tracks the finger in both directions: dragged out from the left
  // edge when closed, and pushed back by the uncovered pane when open. It is
  // being moved by the gesture rather than triggered by it.
  //
  // Read through a ref because PanResponder is built once and would otherwise
  // capture the state from that first render forever.
  const menuOpenRef = useRef(menuOpen);
  menuOpenRef.current = menuOpen;
  const edgeSwipe = useRef(
    PanResponder.create({
      // Claim only clearly horizontal movement, and only the direction that has
      // somewhere to go, so a scroll is never stolen.
      onMoveShouldSetPanResponder: (_event, gesture) => {
        const enough = Math.abs(gesture.dx) > theme.space(2);
        const horizontal = Math.abs(gesture.dx) > Math.abs(gesture.dy) * 2;
        const claim = enough && horizontal && gesture.dx > 0 !== menuOpenRef.current;
        // Leaving the conversation, even a little: the drawer is a different
        // place, so the keyboard goes the moment the drag is claimed rather
        // than once it commits. Switching a model does not do this — that is
        // still the same conversation.
        //
        // Claim time, not `onPanResponderGrant`: the strip only has to win the
        // responder for the drawer to start moving, and a grant that is later
        // terminated by another responder would never have dismissed at all.
        if (claim) Keyboard.dismiss();
        return claim;
      },
      onPanResponderGrant: () => {
        // The effect below animates this same value on `menuOpen`. Stopping it
        // here means the finger takes over from wherever it currently rests.
        drawer.stopAnimation();
      },
      onPanResponderMove: (_event, gesture) => {
        const base = menuOpenRef.current ? 1 : 0;
        drawer.setValue(
          Math.min(1, Math.max(0, base + gesture.dx / DRAWER_WIDTH)),
        );
      },
      onPanResponderRelease: (_event, gesture) => {
        // Signed against the one direction that has somewhere to go, so a drag
        // that is pulled back or flicked in reverse cancels rather than
        // committing on distance alone.
        const toward = menuOpenRef.current ? -gesture.dx : gesture.dx;
        const thrown = menuOpenRef.current ? -gesture.vx : gesture.vx;
        const commit = toward > DRAWER_WIDTH / 2 || thrown > 0.4;
        const open = commit ? !menuOpenRef.current : menuOpenRef.current;
        haptics.tap();
        // Unchanged state would not re-run the effect, so settle here too.
        if (open === menuOpenRef.current) settleDrawer(open);
        else setMenuOpen(open);
      },
      onPanResponderTerminate: () => settleDrawer(menuOpenRef.current),
    }),
  ).current;

  // Belt and braces for every other way in: the hamburger, a swipe that the
  // strip lost, a session opened from the drawer. The drawer is never the place
  // to be typing into the conversation behind it.
  useEffect(() => {
    if (menuOpen) Keyboard.dismiss();
  }, [menuOpen]);

  // Composing takes the screen. iOS gets `will`, so the button is gone before
  // the keyboard arrives rather than vanishing once it has settled; Android
  // only ever emits `did`, and listening for `will` there would never fire.
  useEffect(() => {
    const willShow = Platform.OS === "ios";
    const shown = Keyboard.addListener(
      willShow ? "keyboardWillShow" : "keyboardDidShow",
      () => setTyping(true),
    );
    const hidden = Keyboard.addListener(
      willShow ? "keyboardWillHide" : "keyboardDidHide",
      () => setTyping(false),
    );
    return () => {
      shown.remove();
      hidden.remove();
    };
  }, []);

  const openSession = useCallback(
    (id: string) => {
      // Remounts the thread so it re-arms at this transcript's own bottom.
      // Deliberately not `daemon.sessionId`: a fresh conversation renders its
      // optimistic first prompt before the daemon assigns an id, and keying on
      // that would tear the list down mid-reply the moment the id landed.
      setThreadKey(id);
      daemon.openSession(id);
      setMenuOpen(false);
    },
    [daemon.openSession],
  );

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text) return;

    if (daemon.sessionId) {
      daemon.prompt(text);
    } else {
      // No session yet: start one with the chosen available agent and let the
      // daemon deliver this prompt as soon as it is ready.
      if (!active?.available) return;
      daemon.start(active.id, text);
    }
    setDraft("");
  }, [draft, daemon.sessionId, daemon.prompt, daemon.start, active]);

  const newConversation = useCallback(() => {
    daemon.leave();
    setMenuOpen(false);
  }, [daemon.leave]);

  const pickCommand = useCallback((command: SlashCommand) => {
    // Placed in the composer rather than sent: a command may still want an
    // argument, and even one that does not should be reviewed before running.
    setDraft(applyCommand(command));
    setCommandsOpen(false);
    // Straight back to typing, caret after the trailing space. Deferred past
    // this commit because the sheet still holds focus during it, and focusing
    // a field the system is about to blur does nothing.
    requestAnimationFrame(() => composer.current?.focus());
  }, []);

  const closeCommands = useCallback(() => setCommandsOpen(false), []);

  const closePicker = useCallback(() => setPicker(null), []);

  // Images the agent named by path live on the desktop, and the socket is the
  // only way to them. Provided here rather than passed down because pictures
  // also appear inside markdown, well below anything this screen renders
  // directly. Memoised: a new object every keystroke would re-render every
  // image in the transcript.
  const imageResolver = useMemo(
    () => ({
      images: daemon.images,
      fetchImage: daemon.fetchImage,
      retryImage: daemon.retryImage,
    }),
    [daemon.images, daemon.fetchImage, daemon.retryImage],
  );

  return (
    <ImageResolverProvider value={imageResolver}>
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
        onOpenSession={openSession}
        onNewConversation={newConversation}
        historyLoading={daemon.loadingSessions}
        reduceMotion={reduceMotion}
        machineLabel={pairing.label}
        machineRemote={pairing.remote}
        connectionStatus={daemon.status}
        onUnpair={onUnpair}
      />

      {/* The conversation pane. Slides right to reveal the drawer beneath. */}
      <Animated.View style={[styles.pane, { transform: [{ translateX: slideX }] }]}>
      {/* Starts below the nav: this strip is the hit target for anything it
          covers, and over the nav it would swallow taps on the menu button. */}
      {!menuOpen && (
        <View
          style={[styles.edgeSwipe, { top: insets.top + navHeight }]}
          {...edgeSwipe.panHandlers}
        />
      )}
      {/* Full-bleed on both edges: the thread runs behind the status bar and
          down to the home indicator, and a ProgressiveBlur covers each of those
          regions, so content dissolves into frosted chrome at both ends rather
          than meeting a solid band. The dock carries the bottom inset itself. */}
      <SafeAreaView style={styles.paneInner} edges={[]}>

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

      {/* The one thing the keyboard moves: the thread and the dock ride up as a
          single transform, so the gap between them never changes and nothing
          re-lays out on the keyboard's clock. */}
      <Reanimated.View style={[styles.body, keyboard.pane]}>
        {inThread ? (
          // Remounted per conversation so `startRenderingFromBottom` re-arms:
          // each transcript must open on its own newest message, not on the
          // scroll offset the previous one happened to be left at.
          <ChatThread
            key={threadKey}
            ref={scroller}
            turns={daemon.turns}
            threadTop={threadTop}
            threadBottom={threadBottom}
            working={working}
            indicatorTop={insets.top + navHeight}
            indicatorBottom={dockHeight}
            onAtBottomChange={setAtBottom}
          />
        ) : !daemon.loadingSession ? (
          // Cancels half the pane's lift, so the greeting settles in the middle
          // of the shrunken screen instead of riding the composer all the way up.
          <Reanimated.View style={[styles.greetingLift, keyboard.centred]}>
            {/* Tapping the empty state dismisses the keyboard, which collapses
                the composer. Without this the greeting is inert and the only way
                out of the expanded state is the keyboard's own dismiss control. */}
            <Pressable
              style={styles.greeting}
              accessibilityRole="button"
              accessibilityLabel="Dismiss keyboard"
              onPress={Keyboard.dismiss}
            >
              <Reanimated.View style={keyboard.settled}>
                <Orb
                  color={active?.color}
                  size={ORB_REST_SIZE}
                  busy={daemon.busy}
                />
              </Reanimated.View>
              <Text style={styles.greetingText}>
                {daemon.status !== "online"
                  ? "Connecting to your machine..."
                  : active
                    ? `What would you like ${active.name} to do?`
                    : "No agents available on this machine."}
              </Text>
            </Pressable>
          </Reanimated.View>
        ) : null}

        <View style={[styles.dockOverlay, { bottom: 0 }]}>
          {/* Only ever a way back down: there is no jump-to-top, because the top
              of a transcript is history and the end is where work happens. */}
          <Animated.View
            pointerEvents={atBottom ? "none" : "auto"}
            style={[styles.jumpToEnd, { opacity: jumpOpacity }]}
          >
            <CircleButton
              label="Scroll to latest message"
              onPress={() => {
                // The thread only rides the keyboard from the bottom, and the
                // scroll that gets there is animated — so claim the state now
                // rather than waiting for the last frame's scroll event.
                setAtBottom(true);
                scroller.current?.scrollToEnd({ animated: !reduceMotion });
              }}
              size={theme.size.chip}
            >
              <Ionicons name="arrow-down" size={18} color={theme.color.text} />
            </CircleButton>
          </Animated.View>
          {dockHeight > 0 && (
            <ProgressiveBlur edge="bottom" height={dockHeight} style={styles.dockCover} />
          )}
          <View
            style={[
              styles.dock,
              // Constant. The spacer below the body carries the keyboard, and it
              // already gives this clearance back, so the composer keeps the
              // same gap above either boundary without re-laying out.
              { paddingBottom: insets.bottom + theme.space(2) },
            ]}
            onLayout={(event) => setDockHeight(event.nativeEvent.layout.height)}
          >

          {daemon.permission ? (
            <Glass radius={theme.radius.composer} tier="raised">
              <View style={styles.approvalDock} accessibilityLiveRegion="assertive">
                <View style={styles.approvalHeader}>
                  <Text style={styles.approvalLabel}>APPROVAL NEEDED</Text>
                  <Text
                    numberOfLines={2}
                    ellipsizeMode="tail"
                    style={styles.approvalTitle}
                  >
                    {daemon.permission.title}
                  </Text>
                </View>
                <View style={styles.approvalActions}>
                  {selectApprovalOptions(daemon.permission.options).map((option) => {
                    const deny = isDenyApprovalOption(option);
                    // Capture the request id before another connected client can
                    // answer and clear the pending permission.
                    const requestId = daemon.permission!.requestId;
                    return (
                      <Pressable
                        key={option.optionId}
                        accessibilityRole="button"
                        accessibilityLabel={option.name}
                        onPress={() => {
                          if (deny) haptics.warned();
                          else haptics.sent();
                          daemon.answer(requestId, option.optionId);
                        }}
                        style={({ pressed }) => [
                          styles.approvalButton,
                          deny ? styles.approvalDeny : styles.approvalAllow,
                          pressed && styles.approvalPressed,
                        ]}
                      >
                        <Text
                          style={[
                            styles.approvalButtonText,
                            deny && styles.approvalDenyText,
                          ]}
                        >
                          {option.name}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            </Glass>
          ) : (
            <>
              {/* Only when the agent offers some — an empty sheet is worse than
                  no button — and never while typing: the draft is the subject
                  then, and the row would only crowd it. */}
              {daemon.commands.length > 0 && !typing && (
                <Pressable
                  style={({ pressed }) => [
                    styles.commandsButton,
                    pressed && styles.commandsButtonPressed,
                  ]}
                  hitSlop={touchSlop(theme.space(1))}
                  accessibilityRole="button"
                  accessibilityLabel="Show commands"
                  onPress={() => setCommandsOpen(true)}
                >
                  <Ionicons name="flash-outline" size={14} color={theme.color.textDim} />
                  <Text style={styles.commandsLabel}>Commands</Text>
                </Pressable>
              )}
              <Composer
                ref={composer}
                value={draft}
                onChangeText={setDraft}
                onSend={send}
                busy={daemon.busy}
                onStop={daemon.cancel}
                editable={daemon.status === "online"}
                placeholder={active ? "Ask me. Task me..." : "Waiting for an agent..."}
              />
            </>
          )}
          </View>
        </View>
      </Reanimated.View>

      {/* Outside the lifted pane: a sheet belongs to the screen's bottom edge,
          not to the composer, so it must not ride up with the keyboard. */}
      <CommandSheet
        visible={commandsOpen}
        commands={daemon.commands}
        onSelect={pickCommand}
        onClose={closeCommands}
      />

      {/* One picker, pointed at whichever pill opened it. The mode selector is
          excluded from the model menu so each pill owns exactly one list. */}
      <ConfigPicker
        visible={picker !== null}
        onClose={closePicker}
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
        // The gesture lives on this wrapper, not the Pressable: Pressable spreads
        // its own responder handlers last and would overwrite them. As the parent
        // it can still claim the touch from the child once a drag begins.
        <View style={StyleSheet.absoluteFill} {...edgeSwipe.panHandlers}>
          <Pressable
            style={StyleSheet.absoluteFill}
            accessibilityRole="button"
            accessibilityLabel="Close menu"
            onPress={() => {
              haptics.tap();
              setMenuOpen(false);
            }}
          />
        </View>
      )}

      </SafeAreaView>
      </Animated.View>
    </View>
    </ImageResolverProvider>
  );
}


const styles = StyleSheet.create({
  // The drawer paints its own panel. Matching the conversation canvas here
  // removes the stray drawer-coloured band beneath the closed pane/home area.
  root: { flex: 1, backgroundColor: theme.color.bg },
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


  greetingLift: { flex: 1 },
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

  // One consistent gap between the thread and the composer, kept when the
  // keyboard is open so the last message never hides behind the input.
  dock: {
    paddingHorizontal: theme.gutter,
    paddingTop: theme.space(2),
  },
  dockOverlay: {
    position: "absolute",
    left: 0,
    right: 0,
    zIndex: 3,
  },
  // Behind the composer, filling the wrapper it shares with it.
  dockCover: { zIndex: 0 },

  // Rides above the composer it belongs to, at the gutter it shares with the
  // thread, so it lands over the conversation rather than over the input.
  // Its own row above the composer, left-aligned with the thread's text rail so
  // it reads as belonging to the conversation rather than to the input.
  commandsButton: {
    alignSelf: "flex-start",
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1),
    height: theme.size.control,
    paddingHorizontal: theme.space(3),
    marginBottom: theme.space(2),
    borderRadius: theme.radius.pill,
    backgroundColor: theme.color.surface,
  },
  commandsButtonPressed: { backgroundColor: theme.color.surfacePressed },
  commandsLabel: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    fontWeight: "600",
  },

  jumpToEnd: {
    position: "absolute",
    right: theme.gutter,
    bottom: "100%",
    marginBottom: theme.space(2),
    zIndex: 1,
  },

  // A narrow strip: wide enough to catch a deliberate edge swipe, too narrow to
  // interfere with anything the conversation itself does.
  edgeSwipe: {
    position: "absolute",
    left: 0,
    bottom: 0,
    width: theme.space(5),
    zIndex: 4,
  },

  approvalDock: {
    padding: theme.space(2.5),
    gap: theme.space(2),
  },
  approvalHeader: {
    maxHeight: 58,
    overflow: "hidden",
    gap: theme.space(1),
    paddingHorizontal: theme.space(1),
  },
  approvalLabel: {
    color: theme.color.accent,
    fontSize: theme.font.tiny,
    fontWeight: "700",
    letterSpacing: 1,
  },
  approvalTitle: {
    color: theme.color.text,
    fontSize: theme.font.small,
    maxHeight: 40,
    overflow: "hidden",
    lineHeight: 20,
    fontWeight: "500",
  },
  approvalActions: { flexDirection: "row", gap: theme.space(2) },
  approvalButton: {
    flex: 1,
    minWidth: 0,
    minHeight: theme.size.touch,
    borderRadius: theme.radius.md,
    alignItems: "center",
    justifyContent: "center",
    paddingHorizontal: theme.space(2),
  },
  approvalAllow: {
    backgroundColor: theme.approval.allowFill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(255,255,255,0.42)",
  },
  approvalDeny: {
    backgroundColor: theme.approval.rejectFill,
    borderWidth: 1,
    borderColor: theme.approval.rejectRim,
  },
  approvalPressed: { opacity: 0.72 },
  approvalButtonText: {
    color: theme.approval.allowText,
    fontSize: theme.font.small,
    fontWeight: "700",
    textAlign: "center",
  },
  approvalDenyText: { color: theme.approval.rejectText },
});
