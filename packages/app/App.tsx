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
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
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
import { alignCompletedHistoryToBottom } from "./src/historyScroll";
import { HISTORY_PAGE_SIZE, nextHistoryLimit, visibleHistoryTurns } from "./src/historyWindow";
import { isDenyApprovalOption, selectApprovalOptions } from "./src/approvalOptions";
import { useDaemon, type Provider, type Turn as TurnData } from "./src/useDaemon";
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
 * A view exactly as tall as the visible keyboard.
 *
 * Written from a worklet on every frame of the keyboard's own animation, so the
 * layout above shortens in perfect step. No JS re-render can land halfway
 * through and move things a second time.
 *
 * The keyboard is measured from the physical screen edge, so the home-indicator
 * clearance the dock keeps is handed back while it is open, and the composer
 * keeps the same gap above either boundary.
 */
function useKeyboardSpacer(bottomInset: number) {
  const height = useSharedValue(0);

  useKeyboardHandler(
    {
      onMove: (event) => {
        "worklet";
        height.value = Math.max(0, event.height - bottomInset * event.progress);
      },
      onEnd: (event) => {
        "worklet";
        height.value = Math.max(0, event.height - bottomInset * event.progress);
      },
    },
    [bottomInset],
  );

  return useAnimatedStyle(() => ({ height: height.value }));
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
  // The thread's bottom inset and frosted zone track the dock's measured height.
  const [dockHeight, setDockHeight] = useState(0);
  const insets = useSafeAreaInsets();
  const keyboardSpacer = useKeyboardSpacer(insets.bottom);
  const scroller = useRef<ScrollView>(null);
  const pendingPromptAlignment = useRef(false);
  // Measured so the newest exchange can always be scrolled to the top of the
  // reading area, whatever its height.
  const [threadViewport, setThreadViewport] = useState(0);
  const [exchangeHeight, setExchangeHeight] = useState(0);
  // True only after *this* client sends. A resumed transcript must open on its
  // last message like any chat app, so the top-anchoring spacer stays out of it.
  const [anchorNewestPrompt, setAnchorNewestPrompt] = useState(false);
  // Drives the scroll-to-latest control below.
  const [atBottom, setAtBottom] = useState(true);
  const jumpOpacity = useRef(new Animated.Value(0)).current;

  const [pillX, setPillX] = useState<PillX>({
    model: theme.gutter,
    mode: theme.gutter,
  });
  const historyDragActive = useRef(false);
  const [historyTurnLimit, setHistoryTurnLimit] = useState(HISTORY_PAGE_SIZE);
  const reduceMotion = useReducedMotion();
  const drawer = useRef(new Animated.Value(0)).current;
  // A resumed transcript first reveals only its newest turn. Older turns are
  // prepended after the crossfade while native scroll anchoring holds that turn
  // perfectly still, so opening history never performs a visible mega-scroll.
  const [historyPreview, setHistoryPreview] = useState<TurnData[] | null>(null);
  const [showHistorySkeleton, setShowHistorySkeleton] = useState(false);
  // The turn array may already be complete when the preview swaps out, so this
  // gives the final scroll-to-bottom its own render signal.
  const [historyRevealVersion, setHistoryRevealVersion] = useState(0);
  const historyWasLoading = useRef(false);
  const historyTransitionActive = useRef(false);
  const latestTurns = useRef(daemon.turns);
  latestTurns.current = daemon.turns;
  const threadOpacity = useRef(new Animated.Value(1)).current;
  const historySkeletonOpacity = useRef(new Animated.Value(0)).current;

  const active: Provider | undefined =
    daemon.providers.find((p) => p.id === daemon.activeProviderId) ??
    daemon.providers.find((p) => p.available);

  const inThread = daemon.turns.length > 0;
  const completeRenderedTurns = historyPreview ?? daemon.turns;
  const renderedTurns = visibleHistoryTurns(completeRenderedTurns, historyTurnLimit);
  const hasEarlierTurns =
    historyPreview === null && daemon.turns.length > historyTurnLimit;
  // The newest exchange starts at the last prompt and runs to the end of the
  // transcript. It is rendered as one measured block so the prompt can be lifted
  // to the top of the reading area without ever scrolling past the content.
  const newestPromptIndex = renderedTurns.reduce(
    (found, turn, index) => (turn.role === "user" ? index : found),
    -1,
  );
  const headTurns =
    newestPromptIndex === -1 ? renderedTurns : renderedTurns.slice(0, newestPromptIndex);
  const tailTurns =
    newestPromptIndex === -1 ? [] : renderedTurns.slice(newestPromptIndex);

  // Where the reading area begins and ends: under the nav, and above the
  // composer. UIKit adds the keyboard's own inset on top of this.
  const threadTop = insets.top + (navHeight || theme.space(12)) + theme.space(2);
  const threadBottom = dockHeight + theme.space(2);
  // Empty room held below the newest exchange so its prompt can sit at the top
  // of the reading area. Deliberately independent of the keyboard: the lift
  // below is switched off by this value, so letting the keyboard shrink it would
  // re-enable the lift the moment the keyboard opened.
  const tailSpacer = anchorNewestPrompt
    ? Math.max(0, threadViewport - threadTop - threadBottom - exchangeHeight)
    : 0;
  const working = daemon.busy && !daemon.loadingSession;

  const loadEarlierTurns = useCallback(() => {
    setHistoryTurnLimit((current) => nextHistoryLimit(current, daemon.turns.length));
  }, [daemon.turns.length]);

  useEffect(() => {
    // Each opened conversation begins with one lightweight page. The full fold
    // remains in memory, so revealing an older page needs no agent round-trip.
    setHistoryTurnLimit(HISTORY_PAGE_SIZE);
    historyDragActive.current = false;
    // A measurement from the previous conversation would size this one's trailing
    // spacer until its own layout lands, which reads as a jump on open.
    setExchangeHeight(0);
    setAnchorNewestPrompt(false);
    // An opened conversation lands on its newest message, so it starts at the
    // bottom regardless of where the previous one had been scrolled to.
    setAtBottom(true);
  }, [daemon.sessionId]);

  // Model, permission mode and thinking level are whatever this agent
  // advertised; pew2 keeps no model list of its own. Mode gets its own pill:
  // folding it into the model pill would hide whichever one lost.
  const { model, mode: modeOption, level } = summarise(daemon.configOptions);
  // Never let one selector drive two pills.
  const mode = modeOption && modeOption.id !== model?.id ? modeOption : undefined;

  useEffect(() => {
    if (daemon.loadingSession) {
      historyWasLoading.current = true;
      historyTransitionActive.current = true;
      setHistoryPreview([]);
      setShowHistorySkeleton(true);
      threadOpacity.stopAnimation();
      historySkeletonOpacity.stopAnimation();
      threadOpacity.setValue(0);
      historySkeletonOpacity.setValue(1);
      return;
    }
    if (!historyWasLoading.current) return;
    historyWasLoading.current = false;

    const turns = latestTurns.current;
    const newest = turns[turns.length - 1];
    if (!newest) {
      threadOpacity.setValue(1);
      historySkeletonOpacity.setValue(0);
      setHistoryPreview(null);
      setShowHistorySkeleton(false);
      historyTransitionActive.current = false;
      return;
    }

    // Commit the anchored newest turn before beginning the reveal. This frame is
    // what prevents the full transcript from ever painting at scroll position 0.
    setHistoryPreview([newest]);
    let cancelled = false;
    const frame = requestAnimationFrame(() => {
      if (cancelled) return;
      const finish = () => {
        if (cancelled) return;
        // Prepending the rest is invisible below the opaque thread; the
        // ScrollView's maintainVisibleContentPosition keeps `newest` stationary.
        setHistoryPreview(null);
        setShowHistorySkeleton(false);
        historyTransitionActive.current = false;
        setHistoryRevealVersion((version) => version + 1);
      };

      if (reduceMotion) {
        threadOpacity.setValue(1);
        historySkeletonOpacity.setValue(0);
        finish();
        return;
      }

      Animated.parallel([
        Animated.timing(threadOpacity, {
          toValue: 1,
          duration: 240,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
        Animated.timing(historySkeletonOpacity, {
          toValue: 0,
          duration: 180,
          easing: Easing.out(Easing.cubic),
          useNativeDriver: true,
        }),
      ]).start(({ finished }) => {
        if (finished) finish();
      });
    });

    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      threadOpacity.stopAnimation();
      historySkeletonOpacity.stopAnimation();
    };
  }, [daemon.loadingSession, historySkeletonOpacity, reduceMotion, threadOpacity]);

  useEffect(() => {
    if (historyRevealVersion === 0 || anchorNewestPrompt) return;
    // The full transcript mounts in this commit. Wait one native frame for its
    // content size, then land directly on the newest message without a mega-scroll.
    // Re-runs when the composer reports its height, because that changes the
    // thread's bottom inset and would otherwise leave the last message adrift.
    const frame = requestAnimationFrame(() =>
      alignCompletedHistoryToBottom(scroller.current),
    );
    return () => cancelAnimationFrame(frame);
  }, [historyRevealVersion, anchorNewestPrompt, dockHeight]);

  useEffect(() => {
    if (!daemon.permission) return undefined;
    // The approval control is taller than the composer it replaces. Once its
    // measured height lands, move the final tool row above it instead of letting
    // that row remain underneath the approval buttons.
    const frame = requestAnimationFrame(() =>
      scroller.current?.scrollToEnd({ animated: false }),
    );
    return () => cancelAnimationFrame(frame);
  }, [daemon.permission, dockHeight]);

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
        return enough && horizontal && gesture.dx > 0 !== menuOpenRef.current;
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

  const openSession = (id: string) => {
    const stored = daemon.sessions.find((session) => session.id === id);
    if (stored?.agentSessionId) {
      // Prime the transition in the tap's own render so there is never a blank
      // frame between the drawer closing and the loading skeleton appearing.
      historyWasLoading.current = true;
      historyTransitionActive.current = true;
      setHistoryPreview([]);
      setShowHistorySkeleton(true);
      threadOpacity.stopAnimation();
      historySkeletonOpacity.stopAnimation();
      threadOpacity.setValue(0);
      historySkeletonOpacity.setValue(1);
    }
    daemon.openSession(id);
    setMenuOpen(false);
  };

  const send = () => {
    const text = draft.trim();
    if (!text) return;

    // The newly committed user turn owns the reading origin. Its onLayout below
    // places it directly beneath the nav and then leaves that position alone as
    // the reply streams in.
    if (daemon.sessionId) {
      pendingPromptAlignment.current = true;
      setAnchorNewestPrompt(true);
      daemon.prompt(text);
    } else {
      // No session yet: start one with the chosen available agent and let the
      // daemon deliver this prompt as soon as it is ready.
      if (!active?.available) return;
      pendingPromptAlignment.current = true;
      setAnchorNewestPrompt(true);
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
        onOpenSession={openSession}
        onNewConversation={() => {
          daemon.leave();
          setMenuOpen(false);
        }}
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

      <View style={styles.body}>
        {renderedTurns.length > 0 ? (
          <Animated.ScrollView
            ref={scroller}
            style={[styles.thread, { opacity: threadOpacity }]}
            // When older history is prepended after the newest-turn reveal,
            // keep that newest turn pinned instead of shifting the viewport.
            maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
            onLayout={(event) => setThreadViewport(event.nativeEvent.layout.height)}
            accessibilityElementsHidden={showHistorySkeleton}
            importantForAccessibility={showHistorySkeleton ? "no-hide-descendants" : "auto"}
            // Content still dissolves beneath the floating chrome, but the
            // indicator stays sharp inside the unobscured reading area.
            automaticallyAdjustsScrollIndicatorInsets={false}
            // The spacer below shortens this view's container instead. A second
            // inset here would be a differently-timed adjustment on top of it.
            automaticallyAdjustKeyboardInsets={false}
            scrollIndicatorInsets={{
              top: insets.top + navHeight,
              bottom: dockHeight,
            }}
            contentContainerStyle={[
              styles.threadContent,
              {
                // Clear the status bar plus the nav before the first message,
                // and the composer after the last.
                paddingTop: threadTop,
                paddingBottom: threadBottom,
              },
            ]}
            keyboardDismissMode="interactive"
            keyboardShouldPersistTaps="handled"
            // 60fps sampling and the platform's own deceleration: anything
            // coarser makes the paging check below land mid-flick, which reads
            // as the thread snagging under the finger.
            scrollEventThrottle={16}
            decelerationRate="normal"
            onScrollBeginDrag={() => {
              historyDragActive.current = true;
            }}
            onScrollEndDrag={() => {
              historyDragActive.current = false;
            }}
            onScroll={(event) => {
              const { contentOffset, contentSize, layoutMeasurement } =
                event.nativeEvent;
              // A whole line of slack: a thread resting a few points off the end
              // is still "at the bottom" to the reader.
              setAtBottom(
                contentOffset.y + layoutMeasurement.height >=
                  contentSize.height - theme.line.body,
              );

              if (
                historyDragActive.current &&
                hasEarlierTurns &&
                contentOffset.y <= theme.space(4)
              ) {
                // One page per upward gesture prevents a single momentum event
                // from mounting an entire giant transcript again.
                historyDragActive.current = false;
                loadEarlierTurns();
              }
            }}
          >
            {hasEarlierTurns && (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Load 15 earlier messages"
                onPress={loadEarlierTurns}
                style={({ pressed }) => [
                  styles.loadEarlier,
                  pressed && styles.loadEarlierPressed,
                ]}
              >
                <Ionicons name="chevron-up" size={14} color={theme.color.textDim} />
                <Text style={styles.loadEarlierText}>Earlier messages</Text>
              </Pressable>
            )}
            {headTurns.map((turn) => (
              <Turn key={turn.id} turn={turn} />
            ))}

            {/* The newest exchange is measured as one block: the prompt plus
                everything the agent has said since. The spacer below it is what
                lets that prompt reach the top of the reading area by ordinary
                scrolling, instead of an out-of-bounds jump the user cannot undo. */}
            {tailTurns.length > 0 && (
              <View
                style={styles.exchange}
                onLayout={(event) => {
                  const { y, height } = event.nativeEvent.layout;
                  setExchangeHeight(height);
                  if (!pendingPromptAlignment.current) return;
                  pendingPromptAlignment.current = false;
                  scroller.current?.scrollTo({
                    y: Math.max(0, y - threadTop),
                    animated: !reduceMotion,
                  });
                }}
              >
                {tailTurns.map((turn) => (
                  <Turn key={turn.id} turn={turn} />
                ))}
                {working && <Working />}
              </View>
            )}
            {tailTurns.length === 0 && working && <Working />}

            {tailSpacer > 0 && <View style={{ height: tailSpacer }} />}
          </Animated.ScrollView>
        ) : !daemon.loadingSession && !showHistorySkeleton ? (
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
        ) : null}

        {(daemon.loadingSession || showHistorySkeleton) && (
          <Animated.View
            pointerEvents="none"
            style={[styles.historySkeleton, { opacity: historySkeletonOpacity }]}
          >
            <ThreadSkeleton />
          </Animated.View>
        )}

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
            <Composer
              value={draft}
              onChangeText={setDraft}
              onSend={send}
              busy={daemon.busy}
              onStop={daemon.cancel}
              editable={daemon.status === "online"}
              placeholder={active ? "Ask me. Task me..." : "Waiting for an agent..."}
            />
          )}
          </View>
        </View>
      </View>

      {/* The one thing the keyboard moves. Everything above is laid out inside
          the body, so shortening it here raises the thread and the dock as a
          single layout on the keyboard's own clock. */}
      <Reanimated.View style={keyboardSpacer} />

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

  thread: { flex: 1 },
  threadContent: {
    flexGrow: 1,
    // Bottom-anchored, like every chat. This is also what makes the keyboard
    // feel instant: a short thread rests on the bottom edge, so shortening the
    // container moves it immediately, instead of leaving it pinned to the top
    // until the scroll offset is clamped at the end of the animation.
    justifyContent: "flex-end",
    paddingHorizontal: theme.gutter,
    paddingTop: theme.space(4),
    paddingBottom: theme.space(2),
    gap: theme.space(5),
  },
  // Matches the gap the thread puts between top-level turns, so grouping the
  // newest exchange changes nothing about how it reads.
  exchange: { gap: theme.space(5) },
  loadEarlier: {
    alignSelf: "center",
    minHeight: theme.size.touch,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1),
    paddingHorizontal: theme.space(3),
    borderRadius: theme.radius.pill,
  },
  loadEarlierPressed: { backgroundColor: theme.color.surfacePressed },
  loadEarlierText: {
    color: theme.color.textDim,
    fontSize: theme.font.small,
    fontWeight: "600",
  },
  historySkeleton: {
    position: "absolute",
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 1,
    backgroundColor: theme.color.bg,
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
