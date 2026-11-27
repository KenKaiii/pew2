/**
 * The main screen: drawer, conversation, home greeting, composer and every
 * sheet, as states of one surface. `App.tsx` mounts it once paired.
 */
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Animated,
  AppState,
  Keyboard,
  Linking,
  Pressable,
  StyleSheet,
  View,
} from "react-native";
import { GestureDetector } from "react-native-gesture-handler";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import Reanimated from "react-native-reanimated";
import { StatusBar } from "expo-status-bar";
import { theme } from "./theme";
import { styles } from "./appStyles";
import { useDaemon, type Provider } from "./useDaemon";
import { projectDrawerRows } from "./historyMetadata";
import { restorePresentation } from "./restoreState";
import { currentTool } from "./activity";
import { dockHeightFor, recordDockHeight, type DockHeights } from "./dockHeight";
import { clearConversationNotices, setOpenConversation, setWaitingBadge } from "./ui/notifier";
import { useTurnBanners } from "./ui/useTurnBanners";
import { useAppActive } from "./ui/useAppActive";
import { waitingCount } from "./notificationPolicy";
import { onWidgetLink, useHomeWidget } from "./ui/useHomeWidget";
import { widgetSnapshot } from "./widgetSnapshot";
import { homeDashboard, homeLink } from "./homeDashboard";
import { HomeDashboard } from "./ui/HomeDashboard";
import { pushAddress } from "./ui/push";
import { ComposerDock, type ComposerDockHandle } from "./ui/ComposerDock";
import { ChatThread, type ChatThreadRef } from "./ui/ChatThread";
import { ImageResolverProvider } from "./ui/ChatImage";
import { CommandSheet } from "./ui/CommandSheet";
import { NewChatSheet } from "./ui/NewChatSheet";
import { AttachmentSheet } from "./ui/AttachmentSheet";
import { useAttachments } from "./ui/useAttachments";
import { useDictation } from "./ui/useDictation";
import { QueuedStrip } from "./ui/QueuedStrip";
import { isGoalsProvider } from "./goalsAgent";
import { ThoughtSheet } from "./ui/ThoughtSheet";
import { applyCommand, type SlashCommand } from "./slashCommands";
import { CircleButton } from "./ui/controls";
import { DotGlyph } from "./ui/stage/DotGlyph";
import { haptics } from "./ui/haptics";
import { Sidebar } from "./ui/Sidebar";
import { ConnectionSheet } from "./ui/ConnectionSheet";
import { AlertsCard } from "./ui/AlertsCard";
import { useAlerts } from "./ui/useAlerts";
import { alertsRowValue } from "./notificationAsk";
import { ContextDetailsSheet } from "./ui/ContextDetailsSheet";
import { projectsForProvider, projectSourceKey } from "./projects";
import { greetingFor, hashSeed } from "./greeting";
import { sounds } from "./ui/sounds";
import { AgentCarousel } from "./ui/AgentCarousel";
import { orderProvidersByRecency } from "./providerRecency";
import { AgentColorProvider } from "./ui/stage/agentColor";
import { pewInk } from "./pew/palette";
import { showsStop } from "./composerState";
import { ConfigPicker, summarise, valueName } from "./ui/ConfigPicker";
import { useReducedMotion } from "./ui/useReducedMotion";
import { useKeyboardLift, useTypingState } from "./ui/useKeyboardLift";
import { useDrawer } from "./ui/useDrawer";
import { useAgentFeedback } from "./ui/useAgentFeedback";
import { useGoalControls } from "./useGoalControls";
import { useDevKeyboardLoop, useDevOpenSession, useDevSheetCycle } from "./devHarness";
import { CanvasCover } from "./ui/CanvasCover";
import { DotGrid } from "./ui/stage/DotGrid";
import type { Pairing } from "./pairing";
import { ScreenTopBar } from "./ui/ScreenTopBar";
import { HomeView } from "./ui/HomeView";
import { GoalSheets } from "./ui/GoalSheets";
import { useVoice } from "./ui/useVoice";
import { CallScreen } from "./ui/CallScreen";
import { VoiceSettingsSheet } from "./ui/VoiceSettingsSheet";
import { callActive, canTalk, talkVisible, voiceSettingsVisible } from "./voiceCall";
import { armingSupported, callsLine, isArmed, ringing } from "./voiceRing";
import { useCallKit } from "./ui/useCallKit";
import { TOUCH_SOUNDS, agentSound } from "./soundsPolicy";
import { loadVoiceConsent, saveVoiceConsent } from "./preferences";
import type { ComposerAnchor, ComposerSelector } from "./ui/Composer";

/** Longest Pew's "Reopening" waits for the full transcript before showing what it has. */
const RESTORE_HOLD_MS = 2500;
const NO_TURNS: never[] = [];
/** Pew's smile on home before the agent switcher opens and carries it on. */
const PEW_HANDOFF_MS = 320;

const hiddenDock = { opacity: 0 } as const;

/** For a prop that needs a function where there is nothing to do. */
const NOOP = () => {};

/** How long a fresh launch's home waits for the computer before saying it can't reach it. */
const HOME_OFFLINE_WAIT_MS = 8000;

export function Pew2({
  pairing,
  onUnpair,
  onFirstPaint,
}: {
  pairing: Pairing;
  onUnpair: () => void;
  /** Home has placed Pew and is drawing smoothly: the splash may go (`App.tsx`). */
  onFirstPaint?: () => void;
}) {
  const { choice, setChoice, voiceRequest, setVoiceRequest, pushExpected, announceTurn } =
    useTurnBanners();
  // useVoice needs the daemon's `post`, and the daemon needs voice's frame
  // listener; a ref breaks the cycle without re-creating either.
  const voiceFrame = useRef<(message: unknown) => void>(() => {});

  // The relay identifies devices by this, and it must match the id baked into
  // the stored pairing URL or the two look like different clients.
  const daemon = useDaemon(pairing.url, pairing.deviceId, pairing.key, {
    onTurnFinished: announceTurn,
    // Supplied from here because obtaining it calls into the Expo SDK, which
    // `useDaemon` deliberately stays clear of. What it buys: the daemon can
    // announce a finished turn even after iOS has suspended this app and taken
    // its socket with it — previously that banner waited for the app to be
    // reopened, which is minutes too late to be worth anything.
    pushAddress,
    onPushRegistered: (registered) => {
      pushExpected.current = registered;
    },
    onFrame: (message) => voiceFrame.current(message),
  });
  // Every touch sound loaded up front, and each agent's voice once the agents
  // are known: a first tap must never wait on a file.
  useEffect(() => {
    sounds.preload(TOUCH_SOUNDS);
  }, []);
  const agentIds = daemon.providers.map((provider) => provider.id).join(",");
  useEffect(() => {
    if (agentIds) sounds.preload(agentIds.split(",").map((id) => agentSound(id)));
  }, [agentIds]);
  const voice = useVoice({ post: daemon.post, online: daemon.status === "online" });
  voiceFrame.current = voice.onFrame;
  const [voiceSettingsOpen, setVoiceSettingsOpen] = useState(
    () => __DEV__ && process.env.EXPO_PUBLIC_DEV_SHEET === "voice",
  );
  // Development only: `EXPO_PUBLIC_DEV_SHEET=voice-chat` opens the newest
  // conversation, then the voice sheet over it (its per-chat row).
  const devVoiceChat = useRef(false);
  /** The voice sheet was opened by Talk: it is the sign-in step before a call. */
  const [voiceForCall, setVoiceForCall] = useState(false);
  const talkable = canTalk(voice.knowledge);
  /** Agreed once that calls go to OpenAI; undefined while the store is read. */
  const [voiceConsent, setVoiceConsent] = useState<boolean | undefined>(undefined);
  useEffect(() => {
    void loadVoiceConsent().then(setVoiceConsent);
  }, []);
  /** The item a call should lead with, held while the sheet asks for sign-in or consent. */
  const [callFocus, setCallFocus] = useState<string | undefined>(undefined);
  const placeCall = voice.startCall;
  // The project and agent on screen: all Pew has to go on when the chat is
  // new and nothing has been sent (no session exists to name).
  const placeCwd = daemon.workspace?.cwd;
  const placeProvider = daemon.effectiveProviderId;
  const callPlace = useMemo(
    () =>
      placeCwd || placeProvider
        ? {
            ...(placeCwd ? { cwd: placeCwd } : {}),
            ...(placeProvider ? { providerId: placeProvider } : {}),
          }
        : undefined,
    [placeCwd, placeProvider],
  );
  // A login on the computer and consent given: straight into the call.
  // Otherwise the sheet first, for the sign-in or the one-time consent.
  const startCall = useCallback(
    (focus?: string) => {
      if (talkable && voiceConsent === true) {
        placeCall(focus, false, daemon.sessionId, callPlace);
        return;
      }
      setCallFocus(focus);
      setVoiceForCall(true);
      setVoiceSettingsOpen(true);
    },
    [talkable, voiceConsent, placeCall, daemon.sessionId, callPlace],
  );
  const talk = useCallback(() => startCall(), [startCall]);
  const closeVoiceSheet = useCallback(() => {
    setVoiceSettingsOpen(false);
    setVoiceForCall(false);
    setCallFocus(undefined);
  }, []);
  const callFromVoiceSheet = useCallback(() => {
    const focus = callFocus;
    if (voiceConsent !== true) {
      setVoiceConsent(true);
      void saveVoiceConsent();
    }
    closeVoiceSheet();
    placeCall(focus, false, daemon.sessionId, callPlace);
  }, [callFocus, voiceConsent, closeVoiceSheet, placeCall, daemon.sessionId, callPlace]);
  /** Hold Talk: the voice sheet, with this conversation's "ring me" row. */
  const talkSettings = useCallback(() => {
    setVoiceForCall(false);
    setVoiceSettingsOpen(true);
  }, []);
  /** Agreeing without a call: choosing to be rung counts (the line is shown beside the choice). */
  const agreeToVoice = useCallback(() => {
    if (voiceConsent === true) return;
    setVoiceConsent(true);
    void saveVoiceConsent();
  }, [voiceConsent]);

  // Answered on the system's call screen: start the call once the daemon is
  // reachable (a lock-screen answer can launch the app cold, offline).
  const [systemAnswer, setSystemAnswer] = useState<{ focus?: string } | undefined>(undefined);
  useCallKit({
    post: daemon.post,
    online: daemon.status === "online",
    consented: voiceConsent === true,
    callActive: callActive(voice.call),
    onAnswer: (focus) => setSystemAnswer({ focus }),
    // A hang-up also withdraws an answer still waiting for the connection:
    // events queued at a locked launch replay together, and an answer left
    // behind would start a call after the person had already hung up.
    onHangUp: () => {
      setSystemAnswer(undefined);
      voice.hangUp();
    },
    onMute: voice.setMuted,
    reconnect: daemon.resumeNow,
  });
  useEffect(() => {
    if (!systemAnswer || daemon.status !== "online" || !talkable) return;
    setSystemAnswer(undefined);
    placeCall(systemAnswer.focus, true, daemon.sessionId, callPlace);
  }, [systemAnswer, daemon.status, talkable, placeCall, daemon.sessionId, callPlace]);

  const voiceStatus = voice.knowledge.kind === "known" ? voice.knowledge.status : undefined;
  // The dot on Talk: this chat can ring you (every chat does when Ring me is
  // set to any chat; otherwise only an armed one).
  // The clock voice's time limits are read against: re-read whenever the
  // status changes (the computer says so itself when Ring me runs out).
  const [voiceNow, setVoiceNow] = useState(() => Date.now());
  useEffect(() => {
    setVoiceNow(Date.now());
  }, [voiceStatus]);
  const talkArmed =
    voiceStatus?.prefs?.ringScope === "all"
      ? ringing(voiceStatus.prefs, voiceNow) && daemon.sessionId !== undefined
      : armingSupported(voiceStatus) && isArmed(voiceStatus, daemon.sessionId);
  // Development only: `EXPO_PUBLIC_DEV_TALK=1` presses Talk once, as soon as the
  // daemon has said what voice can do, so the sign-in and call flows can be
  // driven on a simulator nobody is tapping. Stripped from release bundles.
  const devTalked = useRef(false);
  useEffect(() => {
    if (!__DEV__ || process.env.EXPO_PUBLIC_DEV_TALK !== "1" || devTalked.current) return;
    if (daemon.status !== "online" || !talkVisible(voice.knowledge)) return;
    devTalked.current = true;
    // Like a person: a few seconds after the screen settles (the launch
    // itself is busy), with the button's own tap.
    setTimeout(
      () => {
        haptics.tap();
        talk();
      },
      Number(process.env.EXPO_PUBLIC_DEV_TALK_DELAY_MS ?? 0),
    );
  }, [daemon.status, voice.knowledge, talk]);
  // Development only: `EXPO_PUBLIC_DEV_REDIAL_MS` presses "Call again" on the
  // end card that long after a call ends or fails (dismiss, then call at once,
  // exactly as `onRetry` does), `EXPO_PUBLIC_DEV_REDIAL_COUNT` times (1).
  const devRedials = useRef(0);
  const devPhase = voice.call.phase;
  const devDismiss = voice.dismiss;
  useEffect(() => {
    const ms = Number(process.env.EXPO_PUBLIC_DEV_REDIAL_MS ?? 0);
    const count = Number(process.env.EXPO_PUBLIC_DEV_REDIAL_COUNT ?? 1);
    if (
      !__DEV__ ||
      !ms ||
      (devPhase !== "ended" && devPhase !== "failed") ||
      devRedials.current >= count
    )
      return;
    const timer = setTimeout(() => {
      devRedials.current += 1;
      console.log(`[voice] dev redial ${devRedials.current}/${count} after ${devPhase}`);
      haptics.tap();
      devDismiss();
      talk();
    }, ms);
    return () => clearTimeout(timer);
  }, [devPhase, devDismiss, talk]);
  const talkAbout = useCallback((focus: string) => startCall(focus), [startCall]);
  // A tapped voice push opens straight into a call, once the daemon is up.
  useEffect(() => {
    if (
      !voiceRequest ||
      daemon.status !== "online" ||
      voice.knowledge.kind === "unknown" ||
      voiceConsent === undefined
    )
      return;
    setVoiceRequest(undefined);
    if (talkable) startCall(voiceRequest.focus);
  }, [
    voiceRequest,
    daemon.status,
    voice.knowledge.kind,
    voiceConsent,
    talkable,
    startCall,
    setVoiceRequest,
  ]);

  const [drawerProjection, setDrawerProjection] = useState(() => ({
    source: daemon.sessions,
    rows: projectDrawerRows([], daemon.sessions),
  }));
  if (drawerProjection.source !== daemon.sessions) {
    setDrawerProjection({
      source: daemon.sessions,
      rows: projectDrawerRows(drawerProjection.rows, daemon.sessions),
    });
  }

  // Retry the socket the moment the app is back, rather than waiting out a
  // backoff that was scheduled while nobody was holding the phone.
  //
  // Subscribed here rather than inside `useDaemon` because that module is
  // reached by the daemon's own tests, and a `react-native` import there pulls
  // RN's global types into the daemon's TypeScript program — where they redefine
  // `setTimeout` and break every `.unref()` in it. `resumeNow` exists to keep
  // that boundary while still letting this side drive the reconnect.
  //
  // A second listener rather than a branch in the `foreground` one above,
  // because that one is declared before `useDaemon` runs and so has no
  // `resumeNow` to call. Reordering the two to share a subscription would put
  // the socket's setup above the ref that decides whether a finished turn needs
  // a banner, which is the more delicate of the two orderings.
  const resumeDaemon = daemon.resumeNow;
  const registerDaemonPush = daemon.registerPush;
  const setDaemonForeground = daemon.setForeground;
  const alerts = useAlerts(registerDaemonPush, pushExpected);
  const askAlerts = alerts.ask;
  useEffect(() => {
    setDaemonForeground(AppState.currentState === "active");
    const subscription = AppState.addEventListener("change", (next) => {
      setDaemonForeground(next === "active");
      if (next === "active") resumeDaemon();
    });
    return () => subscription.remove();
  }, [resumeDaemon, setDaemonForeground]);

  // The rest of the hook's actions, pulled out for the same reason as
  // `resumeDaemon` above: `daemon` is a fresh object every render (it spreads
  // state over actions), while each function on it is stable. Naming them here
  // lets every callback below depend on exactly what it calls, instead of on an
  // identity that changes on every streamed chunk — which would rebuild the
  // memoised dock and transcript cells for each token that arrives.
  const {
    answer: answerDaemon,
    leave: leaveDaemon,
    openSession: openDaemonSession,
    prompt: promptDaemon,
    selectProject: selectDaemonProject,
    start: startDaemon,
  } = daemon;

  // Tell the notification layer which conversation is open, so a push that
  // arrives for the one already on screen is dropped instead of covering the
  // reply it is announcing. The daemon pushes without knowing what this phone is
  // showing — only this side can know that.
  useEffect(() => setOpenConversation(daemon.sessionId), [daemon.sessionId]);

  // The open conversation's banners leave Notification Center once it is
  // actually in front of the user: a "needs your OK" left there after the
  // sheet was answered is a request that no longer exists.
  const appActive = useAppActive();
  useEffect(() => {
    if (appActive && daemon.sessionId) void clearConversationNotices(daemon.sessionId);
  }, [appActive, daemon.sessionId]);

  // The icon's badge: conversations stopped on an answer. The daemon sets it
  // on every push; this keeps it true while the app is awake.
  const waiting = waitingCount(daemon.sessions, daemon.gg.asks);
  useEffect(() => {
    void setWaitingBadge(waiting);
  }, [waiting]);

  // The home and Lock Screen widget: what is waiting, working and new. Built
  // from the drawer's rows rather than the sessions themselves, because those
  // keep their identity across streamed chunks and the sessions do not.
  const widget = useMemo(
    () =>
      widgetSnapshot({
        sessions: drawerProjection.rows,
        asks: daemon.gg.asks,
        providers: daemon.providers,
        machine: daemon.machineName,
      }),
    [drawerProjection.rows, daemon.gg.asks, daemon.providers, daemon.machineName],
  );
  useHomeWidget(widget);
  // Development only: `EXPO_PUBLIC_DEV_HOME=empty` shows home with no sessions.
  const devHome =
    __DEV__ && process.env.EXPO_PUBLIC_DEV_HOME === "empty"
      ? { cards: [], empty: true }
      : undefined;
  const dashboard = useMemo(
    () =>
      homeDashboard({
        sessions: drawerProjection.rows,
        asks: daemon.gg.asks,
        providers: daemon.providers,
      }),
    [drawerProjection.rows, daemon.gg.asks, daemon.providers],
  );
  /**
   * A new conversation whose project and agent were chosen in the New
   * conversation step: the empty conversation with its composer. Without it,
   * and with nothing open, the screen is the home dashboard, which has no
   * composer, so nothing typed can land in a project nobody picked.
   */
  const [composing, setComposing] = useState(false);
  /** The name of a goal just launched, until its conversation has something in it. */
  const [launchingGoal, setLaunchingGoal] = useState<string>();
  // `EXPO_PUBLIC_DEV_SHEET=<name>` (development only) starts with that sheet
  // or overlay open, so each can be checked on the simulator without a tap:
  // attach, connection, context, model, commands, newchat, thought, carousel,
  // checklist, tasks, goalsettings.
  const devSheet = __DEV__ ? process.env.EXPO_PUBLIC_DEV_SHEET : undefined;
  const {
    attachments,
    setAttachments,
    attachmentsRef,
    attachOpen,
    setAttachOpen,
    openAttach,
    closeAttach,
    removeAttachment,
    pickAttachment,
  } = useAttachments(devSheet);
  // `EXPO_PUBLIC_DEV_OPEN_DRAWER=1` (development only) starts with the drawer
  // open, so a simulator check can see it without a tap.
  const [menuOpen, setMenuOpen] = useState(
    () => __DEV__ && process.env.EXPO_PUBLIC_DEV_OPEN_DRAWER === "1",
  );
  const [connectionOpen, setConnectionOpen] = useState(() => devSheet === "connection");
  useEffect(() => {
    if (connectionOpen) setVoiceNow(Date.now());
  }, [connectionOpen]);
  const [contextOpen, setContextOpen] = useState(() => devSheet === "context");
  const openContext = useCallback(() => {
    Keyboard.dismiss();
    setContextOpen(true);
  }, []);
  const closeContext = useCallback(() => setContextOpen(false), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const openConnection = useCallback(() => {
    Keyboard.dismiss();
    setMenuOpen(false);
    setConnectionOpen(true);
  }, []);
  const closeConnection = useCallback(() => setConnectionOpen(false), []);
  const refreshAlerts = alerts.refresh;
  useEffect(() => {
    if (connectionOpen) refreshAlerts();
  }, [connectionOpen, refreshAlerts]);
  // The card is a sheet of its own: the asking sheet steps aside for it.
  const alertsFromRow = useCallback(() => {
    setConnectionOpen(false);
    void askAlerts("row");
  }, [askAlerts]);
  const alertsForRing = useCallback(async () => {
    setVoiceSettingsOpen(false);
    const allowed = await askAlerts("ring");
    setVoiceSettingsOpen(true);
    return allowed;
  }, [askAlerts]);
  // Which pill's menu is open, and where that pill sits, so the menu opens
  // under it instead of always at the gutter.
  const [picker, setPicker] = useState<"model" | "mode" | null>(() =>
    devSheet === "model" ? "model" : null,
  );
  const [commandsOpen, setCommandsOpen] = useState(() => devSheet === "commands");
  const [newChatOpen, setNewChatOpen] = useState(() => devSheet === "newchat");
  // The reasoning currently being read, if any. Held here rather than per turn
  // so the sheet lives outside the recycling list — a cell scrolled off screen
  // must not take the sheet down with it.
  const [thought, setThought] = useState<string | null>(() =>
    devSheet === "thought"
      ? "The chunk is there on reopen, so the daemon has it. The phone drops it.\n\nReplay and live stream overlap at the cursor. If the cursor moves first, the event at the cursor looks like a duplicate."
      : null,
  );
  // The draft lives inside the dock, not here.
  //
  // Holding it at the root meant every keystroke re-rendered the entire app,
  // and the composer's own growth animation then had to share the JS thread
  // with that work — which is what made the box lag the caret on every wrapped
  // line. This handle is how the root still reaches text it no longer owns.
  const composer = useRef<ComposerDockHandle>(null);
  const { typing, typingRef } = useTypingState();
  // Measured so the thread's top inset always matches the real nav height.
  const [navHeight, setNavHeight] = useState(0);
  // The control strip and queue strip ride on top of the composer inside the
  // dock overlay, so the thread has to clear them as well as the composer —
  // measured, like the composer, rather than guessed.
  const [stripsHeight, setStripsHeight] = useState(0);
  // The thread's bottom inset and frosted zone track the dock's measured height.
  //
  // Two heights, not one, because the dock is a different size while you type:
  // the context row is not in it. Measuring a single height meant every keyboard
  // open paid a round trip — the row unmounts, the platform lays the dock out,
  // `onLayout` reports, React re-renders, and only then does the transcript take
  // up the new inset. The keyboard itself is already up by then, so the thread
  // visibly re-seated a few frames after it, which is the lag.
  //
  // Keyed by that state, the second open onwards is instant: the height for the
  // state being entered is already known, so it lands in the same commit as
  // `typing` rather than after a measurement.
  const [dockHeights, setDockHeights] = useState<DockHeights>({ typing: 0, resting: 0 });
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardLift(insets.bottom);
  const scroller = useRef<ChatThreadRef>(null);
  // Identifies the conversation on screen for remount purposes. Every other way
  // of changing conversations empties the transcript first, which unmounts the
  // list on its own; only picking one drawer entry while another is open swaps
  // the turns in place.
  const [threadKey, setThreadKey] = useState("new");
  // A reopened conversation arrives from the computer in batches. Showing the
  // first batch and then re-laying the list as the rest landed read as the
  // chat rendering, vanishing and rendering again, so Pew's "Reopening" stays
  // up until the last batch is in and the transcript appears once. A very
  // long one (still loading after the hold) shows what it has instead of
  // making you wait.
  const [restoreHold, setRestoreHold] = useState(false);
  // Drives the scroll-to-latest control below.
  const [atBottom, setAtBottom] = useState(true);
  const jumpOpacity = useRef(new Animated.Value(0)).current;

  const [pickerAnchor, setPickerAnchor] = useState<ComposerAnchor>();
  const openComposerPicker = useCallback((kind: "model" | "mode", anchor: ComposerAnchor) => {
    setPickerAnchor(anchor);
    setPicker(kind);
  }, []);
  const reduceMotion = useReducedMotion();

  // The agent on screen. Before an explicit choice this is the one used last on
  // this device, resolved by the hook, so re-opening the app lands where the
  // user left off instead of on whichever manifest sorts first.
  // A named id that no longer exists — an agent uninstalled since it was
  // remembered — must not leave the composer pointing at nothing, so the first
  // available agent still backs it up.
  // Why the composer has nothing to talk to.
  //
  // "No agents available" was the fallback for every reason `active` was unset,
  // including the ordinary gap between connecting and the provider list landing
  // — so a working setup flashed what reads as a hard failure. And when it was
  // the true cause, it still named neither the reason nor the fix: the agents
  // are chosen in `pew2 setup`, and nothing on screen said so.
  const emptyReason = (providerCount: number): string =>
    providerCount === 0
      ? "Getting the list of agents..."
      : "No agents are turned on. Run pew2 setup on your computer to choose some.";

  const active: Provider | undefined =
    daemon.providers.find((p) => p.id === daemon.effectiveProviderId) ??
    daemon.providers.find((p) => p.available);
  // How long home waits for an agent before showing without one.
  const [homeWaited, setHomeWaited] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setHomeWaited(true), 900);
    return () => clearTimeout(t);
  }, []);
  // Whether this phone has heard from its computer since launch. Until it
  // has, "offline" is only "not connected yet" (right after pairing the
  // first answer takes a few seconds), so home waits for it, up to
  // HOME_OFFLINE_WAIT_MS, instead of settling on a sleepy, empty Pew and
  // then redrawing everything when the list lands.
  const [everOnline, setEverOnline] = useState(false);
  const [offlineWaited, setOfflineWaited] = useState(false);
  useEffect(() => {
    if (daemon.status === "online") setEverOnline(true);
  }, [daemon.status]);
  useEffect(() => {
    const t = setTimeout(() => setOfflineWaited(true), HOME_OFFLINE_WAIT_MS);
    return () => clearTimeout(t);
  }, []);

  // Projects the selected agent has worked in, and which one the drawer is
  // narrowed to. Derived here rather than in the drawer so both the list and
  // the empty state read from one answer.
  //
  // Keyed on the fields that can actually change the answer rather than on the
  // sessions array itself, which is rebuilt on every streamed chunk. See
  // `projectSourceKey`: `daemon.sessions` is still what the computation reads,
  // but it is no longer what decides whether to run it.
  const activeId = active?.id;
  // The agent's colour as Stage lights it: brand hue, lifted until it reads on
  // the canvas. Every LED label, sheet strip and selected outline uses it.
  // Cheap and pure; the React Compiler memoizes it.
  const agentInk = pewInk(active?.color);
  const daemonSessions = daemon.sessions;
  const projectKey = projectSourceKey(daemonSessions, activeId);
  const projects = useMemo(
    () => projectsForProvider(daemon.projects[activeId ?? ""], daemonSessions, activeId),
    // `projectKey` stands in for `daemonSessions` on purpose — the array is
    // rebuilt on every streamed chunk, and listing it would recompute the fold
    // for every token that arrives. The rule cannot see that one summarises the
    // other, so this is the one place it is overruled by hand.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [daemon.projects, projectKey, activeId],
  );
  const selectedProjectPath = activeId ? daemon.projectPath[activeId] : undefined;
  const selectProject = useCallback(
    (path?: string) => {
      if (activeId) selectDaemonProject(activeId, path);
    },
    [activeId, selectDaemonProject],
  );

  // A goal just launched from the New goal sheet opens straight into its
  // conversation, empty and "Starting" until the kickoff turn arrives. Before
  // this the screen fell back to home for that moment, with the agent's recent
  // chats as cards under a thumb that had just let go of Ken: one stray tap
  // opened some other conversation instead of the goal.
  const launching =
    launchingGoal !== undefined && daemon.turns.length === 0 && !daemon.restoreTarget;
  const inThread = daemon.turns.length > 0 || launching;
  // Home vs conversation: a transcript (or one reopening) is a conversation; so
  // is an open session with nothing in it yet, and a new one whose project and
  // agent were just chosen. Anything else is home.
  // Started: from here on leaving it is going home.
  useEffect(() => {
    if (inThread) setComposing(false);
  }, [inThread]);
  const onHome =
    !inThread &&
    !daemon.restoreTarget &&
    !daemon.loadingSession &&
    daemon.sessionId === undefined &&
    !composing;
  const sessionTitle =
    daemon.restoreTarget?.title ??
    (launching ? launchingGoal : undefined) ??
    daemonSessions.find((session) => session.id === (daemon.sessionId ?? threadKey))?.title ??
    (onHome ? "Home" : "New conversation");

  // Where the reading area begins and ends: under the nav, and above the
  // composer. Both fall back to the resting height of the thing they clear,
  // because `onLayout` only reports after the first paint — and a zero here is
  // a first message rendered hard against the composer, corrected a frame later.
  const threadTop = insets.top + (navHeight || theme.space(12)) + theme.space(2);
  // Mirrors `styles.dock`: the composer at rest, plus that view's own padding.
  const restingDockHeight =
    theme.size.composerResting + theme.space(2) + (insets.bottom + theme.space(2));
  // The height for the state on screen now. Falls back to the other state's
  // measurement before this one has ever been measured — which is only the very
  // first keyboard open of a launch — and to the analytic resting height before
  // either has. Both are closer than a zero, which would put the last message
  // hard against the composer for a frame.
  const dockHeight = dockHeightFor(dockHeights, typing, restingDockHeight);
  const threadBottom = dockHeight + stripsHeight + theme.space(2);
  // Only until the answer itself starts arriving. The indicator occupies exactly
  // one body line at the same offset as the agent's first line, so text replacing
  // it lands where it was and the transcript never shifts — whereas an indicator
  // held below a growing reply would push it for the whole turn.
  // Thinking deliberately does not count: it collapses to one static row, so
  // treating it as an arriving answer would drop the indicator for the whole
  // reasoning phase — minutes, on a remote agent, with nothing moving.
  //
  // A running tool overrides that, because a turn alternates: prose, then more
  // tools. `currentTool` is silent while the agent speaks and speaks again on
  // the next tool call, so this reads the same rule the line itself uses rather
  // than a second opinion about who is talking.
  const newest = daemon.turns[daemon.turns.length - 1];
  const answering = newest?.role === "agent" && newest.text.trim().length > 0;
  const running = currentTool(daemon.activity) !== undefined;
  const working = daemon.busy && !daemon.loadingSession && (running || !answering);

  // Counts arrivals at the empty state, which is the only screen the greeting
  // appears on.
  //
  // `threadKey` is not enough on its own: it stays `"new"` for every new chat,
  // so seeding on it alone would show one fixed line per agent forever — a
  // rotation that never rotates on precisely the path that shows it. Bumped on
  // arrival rather than derived from a clock so the words are still stable
  // while the state is on screen, which is what stops them changing under a
  // reader on every keystroke in the composer.
  const [greetingRound, setGreetingRound] = useState(0);
  useEffect(() => {
    if (!inThread) setGreetingRound((round) => round + 1);
  }, [inThread, threadKey]);

  // Home's agent carousel (tap Pew) and its recent-chat cards.
  const [carouselOpen, setCarouselOpen] = useState(() => devSheet === "carousel");
  // While you're typing, a tap on Pew is far more likely a stray thumb than a
  // wish to switch agent: it only puts the keyboard away. Tapped again with
  // the keyboard down, it opens the carousel.
  useDevKeyboardLoop(composer);

  // One beat between the tap and the switcher: Pew smiles where you touched
  // it, then the switcher opens with its Pew still smiling (it hands the smile
  // over), and that Pew settles back to normal. The same moment continues
  // across the two screens instead of a smile cut off by a page change.
  const [pewSmiling, setPewSmiling] = useState(false);
  const smileTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(smileTimer.current), []);
  const openCarousel = useCallback(() => {
    if (typingRef.current) {
      Keyboard.dismiss();
      return;
    }
    setPewSmiling(true);
    clearTimeout(smileTimer.current);
    // Tapping Pew switches agent, everywhere (home and a new conversation).
    smileTimer.current = setTimeout(() => {
      setCarouselOpen(true);
      setPewSmiling(false);
    }, PEW_HANDOFF_MS);
    // `typingRef` is a ref from `useTypingState`, stable for the component's life.
  }, [typingRef]);
  const closeCarousel = useCallback(() => setCarouselOpen(false), []);
  const carouselAgents = useMemo(
    () =>
      orderProvidersByRecency(daemon.providers, drawerProjection.rows).filter(
        (p) => p.available !== false,
      ),
    [daemon.providers, drawerProjection.rows],
  );
  const online = daemon.status === "online" && !daemon.unreachable;
  const homeStatus = [
    daemon.busy ? "Working" : online ? "Ready" : "Offline",
    daemon.workspace?.folder,
    active?.name,
    daemon.workspace?.repo && (daemon.workspace.uncommitted ?? 0) > 0
      ? `${daemon.workspace.uncommitted} changed`
      : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  const greeting = useMemo(
    () =>
      isGoalsProvider(active?.id)
        ? "What's the goal?"
        : greetingFor(active?.name, hashSeed(`${greetingRound}:${active?.id ?? ""}`)),
    [greetingRound, active?.id, active?.name],
  );

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

  useAgentFeedback(
    daemon.busy,
    daemon.turns,
    daemon.permission,
    daemon.sessionId,
    daemon.loadingSession,
  );

  const { paneSlide, edgeSwipeClosed, edgeSwipeOpen, drawerSwipe } = useDrawer({
    menuOpen,
    setMenuOpen,
    reduceMotion,
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

  const openSession = useCallback(
    (id: string) => {
      // Closing the drawer is urgent; swapping the transcript underneath it is
      // not, and they are separated here because they used to be one render.
      //
      // The spring that closes the drawer is started by an effect on
      // `menuOpen`, and effects run after the commit — so it could not begin
      // until React had finished the work in the same batch. That work is a
      // whole new transcript: `threadKey` changes, the list remounts, and every
      // turn in the conversation mounts and parses its markdown. The drawer
      // therefore stayed still from the tap until all of that had landed, and
      // only then started moving. That pause is the stagger — not a slow
      // animation, a late one, and worst on the longest conversations.
      //
      // Marked non-urgent, the transcript renders in its own pass. The tap now
      // commits nothing but `menuOpen`, the effect fires, and the drawer is
      // already travelling while the turns are built behind it.
      setMenuOpen(false);
      setLaunchingGoal(undefined);
      setComposing(false);
      startTransition(() => {
        // Remounts the thread so it re-arms at this transcript's own bottom.
        // Deliberately not `daemon.sessionId`: a fresh conversation renders its
        // optimistic first prompt before the daemon assigns an id, and keying on
        // that would tear the list down mid-reply the moment the id landed.
        setThreadKey(id);
        openDaemonSession(id);
      });
    },
    [openDaemonSession],
  );

  // Deferred until the conversation the banner named is in the list: a banner
  // can launch the app cold, before the daemon has said what sessions exist,
  // and addressing an unknown id is a no-op that would silently lose it.
  useEffect(() => {
    if (!choice) return;
    if (!daemonSessions.some((session) => session.id === choice.sessionId)) return;
    setChoice(undefined);
    if (choice.text) {
      // Replied from the banner: answer that agent where it is and leave the
      // user wherever they were. Being pulled into another project because you
      // dashed off one line is the thing the reply box exists to avoid.
      if (promptDaemon(choice.text, choice.sessionId)) {
        haptics.sent();
        return;
      }
      // The conversation has to be reloaded first (the daemon was restarted).
      // Open it with the reply waiting in the composer rather than dropping
      // what was typed: one tap to send beats losing it silently.
      composer.current?.setDraft(choice.text);
    }
    openSession(choice.sessionId);
  }, [choice, daemonSessions, promptDaemon, openSession, setChoice]);

  /**
   * Dictation writes straight into the draft.
   *
   * Both sides go through the dock's handle, which is stable: the draft is not
   * state here any more, so there is nothing on this component for a
   * dependency to track and nothing to tear the recogniser's listeners down
   * mid-sentence.
   */
  const dictation = useDictation({
    draft: useCallback(() => composer.current?.getDraft() ?? "", []),
    onDraftChange: useCallback((text: string) => composer.current?.setDraft(text), []),
    onMessage: useCallback((message: string) => {
      Alert.alert("Dictation", message);
    }, []),
  });
  // Same reason as the daemon actions above: the hook's object is new each
  // render, the function on it is not.
  const cancelDictation = dictation.cancel;
  // No sounds while the recogniser listens: a chime would be heard by it.
  useEffect(() => sounds.setListening(dictation.listening), [dictation.listening]);

  // Handed the text by the dock, which owns it.
  //
  // Answers whether the message went. The dock clears the draft on true and
  // keeps it on false, so a send refused below — no agent available to start a
  // conversation with — leaves the words in the box instead of destroying a
  // message that was never delivered.
  // `EXPO_PUBLIC_DEV_NEW_GOAL=1` (development only) opens the New goal screen
  // on launch, for a simulator check without a tap.
  const [newGoalOpen, setNewGoalOpen] = useState(
    () => __DEV__ && process.env.EXPO_PUBLIC_DEV_NEW_GOAL === "1",
  );
  const [newGoalPrefill, setNewGoalPrefill] = useState<string>();
  const send = useCallback(
    (text: string): boolean => {
      // A photo on its own is a message; "look at this" is implied by attaching it.
      if (!text && attachmentsRef.current.length === 0) return false;
      const staged = attachmentsRef.current;

      if (!daemon.sessionId && !active?.available) return false;

      // GG Goals has no free-standing conversation: a message typed on its
      // home screen becomes the goal of a new one (the sheet takes the draft).
      if (!daemon.sessionId && isGoalsProvider(active?.id)) {
        if (!text) return false;
        setNewGoalPrefill(text);
        setNewGoalOpen(true);
        return true;
      }

      // Whatever the recogniser still holds is not going into a message that has
      // already gone, and a live mic outliving the send is what leaves the OS
      // recording indicator on.
      cancelDictation();

      // Asked at the moment it earns itself: the user is about to wait on an
      // agent, which is the only thing this app notifies about. Not awaited — the
      // prompt must go out whatever the system decides. A yes hands the daemon
      // this phone's push address straight away: the connect path never asks,
      // so until now it had nothing to send.
      // The card (`useAlerts`) explains before iOS asks, and only after the
      // message has gone; granted already, it just hands over the push address.
      void askAlerts("send");

      // Offline the message is queued rather than sent, which still counts as
      // taken: it is on screen, marked as waiting, and goes out on reconnect.
      // A false here is the rare genuine refusal — the outbox is full — and the
      // draft and its attachments stay put, because destroying a message that
      // was never delivered is the one outcome there is no way back from.
      const taken = daemon.sessionId
        ? promptDaemon(text, undefined, staged)
        : // No session yet: start one with the chosen available agent and let
          // the daemon deliver this prompt as soon as it is ready.
          startDaemon(active!.id, text, staged);
      if (!taken) return false;
      setAttachments([]);
      return true;
    },
    // Attachments are read through their ref, so staging a photo does not
    // rebuild this and re-render the memoised dock beneath it.
    // `attachmentsRef` and `setAttachments` come from `useAttachments`: stable.
    [
      cancelDictation,
      daemon.sessionId,
      promptDaemon,
      startDaemon,
      active,
      attachmentsRef,
      setAttachments,
      askAlerts,
    ],
  );

  /**
   * Sending a failed prompt again, from the transcript.
   *
   * The same path as the composer, deliberately: a retry has to start a
   * conversation when the daemon was restarted under it, and has to queue when
   * the phone has no signal, exactly as typing it out by hand would.
   *
   * What it cannot bring back is the failed message's attachments — they left
   * the composer when it was sent. It carries whatever is staged now, which is
   * the same rule the composer follows.
   *
   * A refusal has one cause the user can act on: no agent is available to open
   * a conversation with. That lands the prompt in the composer rather than
   * nowhere, so the tap is never silent.
   */
  const retrySend = useCallback(
    (text: string) => {
      if (send(text)) return;
      composer.current?.setDraft(text);
      composer.current?.focus();
    },
    [send],
  );

  // A mic left listening across a session switch would put the next sentence
  // into a conversation the user has already left.
  useEffect(() => {
    cancelDictation();
  }, [daemon.sessionId, cancelDictation]);

  /**
   * Leave the current conversation, with the next one aimed at `cwd`.
   *
   * Aiming it *is* choosing a project, so this goes through the same selection
   * the drawer uses rather than a second, private notion of "where the next
   * chat goes" — two of those would disagree the moment either was used. It
   * narrows the drawer as a side effect, which is the honest reading: the app
   * has one current project, and this just moved it.
   */
  const startNewChat = useCallback(
    (cwd?: string) => {
      // Same split as `openSession`: closing the drawer commits on its own so
      // its slide starts on the tap, and leaving the conversation (the whole
      // home screen mounts in its place: the hero Pew, its glow, the recent
      // cards) renders behind it as a transition. Together in one batch, the
      // drawer sat still until home had finished building, then slid.
      setMenuOpen(false);
      setNewChatOpen(false);
      setLaunchingGoal(undefined);
      startTransition(() => {
        if (cwd && activeId) selectDaemonProject(activeId, cwd);
        leaveDaemon();
        setComposing(true);
      });
    },
    [activeId, selectDaemonProject, leaveDaemon],
  );

  /**
   * New conversation, from anywhere: home, the drawer, the top bar, a widget.
   * Leaves what is open for home and asks for the project and the agent;
   * the composer appears only once both are confirmed (`startNewChat`). A
   * project handed in (the drawer's, beside a named project) is preselected.
   */
  const openNewConversation = useCallback(
    (cwd?: string) => {
      Keyboard.dismiss();
      setMenuOpen(false);
      setLaunchingGoal(undefined);
      setComposing(false);
      startTransition(() => {
        if (cwd && activeId) selectDaemonProject(activeId, cwd);
        leaveDaemon();
      });
      setNewChatOpen(true);
    },
    [activeId, selectDaemonProject, leaveDaemon],
  );
  const openNewFromBar = useCallback(() => openNewConversation(), [openNewConversation]);
  const goHome = useCallback(() => {
    Keyboard.dismiss();
    composer.current?.setDraft("");
    setComposing(false);
    leaveDaemon();
  }, [leaveDaemon]);
  // Choosing an agent in the New conversation step: on home nothing is open,
  // so selecting it ends nothing, and its projects take over the list.
  const selectAgent = daemon.select;
  // Unconfirmed until Start, so a dismissed step lands on home, never on a
  // composer aimed at an agent nobody confirmed.
  const pickAgent = useCallback(
    (id: string) => {
      setComposing(false);
      selectAgent(id);
    },
    [selectAgent],
  );
  useDevOpenSession({
    rows: drawerProjection.rows,
    activeId,
    openSession,
    startNewChat,
    setNewChatOpen,
  });

  // Widget taps. A conversation goes through `setChoice`, exactly like a
  // banner tap, so a widget that launched the app cold waits for the session
  // list the same way. Subscribed once: the subscription re-reads the link the
  // app was launched with, so re-subscribing would act on it again.
  const openNewRef = useRef(openNewConversation);
  openNewRef.current = openNewConversation;
  useEffect(
    () =>
      onWidgetLink((link) => {
        if (link.kind === "open") setChoice({ sessionId: link.sessionId });
        else openNewRef.current();
      }),
    [setChoice],
  );

  const closeNewChat = useCallback(() => setNewChatOpen(false), []);
  // The drawer only ever offers this beside a named project, so it always has
  // a path to hand — no undefined branch to fall back on here.
  // The drawer's New chat: with a project chosen in its pills, straight into
  // that project with the agent already picked; on All, the step that asks.
  const newConversation = useCallback(
    (cwd?: string) => {
      if (cwd && activeId) startNewChat(cwd);
      else openNewConversation(cwd);
    },
    [activeId, startNewChat, openNewConversation],
  );

  const pickCommand = useCallback((command: SlashCommand) => {
    // Placed in the composer rather than sent: a command may still want an
    // argument, and even one that does not should be reviewed before running.
    composer.current?.setDraft(applyCommand(command));
    setCommandsOpen(false);
    // Straight back to typing, caret after the trailing space. Deferred past
    // this commit because the sheet still holds focus during it, and focusing
    // a field the system is about to blur does nothing.
    requestAnimationFrame(() => composer.current?.focus());
  }, []);

  // Stable identities: `ContextBar` is memoized so it does not re-render on
  // every keystroke of the draft, which a fresh handler each render would undo.
  const openCommands = useCallback(() => setCommandsOpen(true), []);

  useEffect(() => {
    if (!__DEV__ || process.env.EXPO_PUBLIC_DEV_SHEET !== "voice-chat" || devVoiceChat.current)
      return;
    if (daemon.status !== "online" || drawerProjection.rows.length === 0) return;
    devVoiceChat.current = true;
    openSession(drawerProjection.rows[0]!.id);
    // Not cleared on re-run: the rows change as the list loads, and the
    // guard above means this effect never schedules it again.
    setTimeout(() => setVoiceSettingsOpen(true), 2500);
  }, [daemon.status, drawerProjection.rows, openSession]);

  // Development only: `EXPO_PUBLIC_DEV_TOUR=1` walks the main actions a few
  // seconds apart with their haptics, logging when each was pressed, so the
  // time from a tap to the screen changing can be measured from a recording.
  const tourRef = useRef({
    openSession,
    setMenuOpen,
    setCarouselOpen,
    setCommandsOpen,
    setNewChatOpen,
    setConnectionOpen,
    sessions: drawerProjection.rows,
    select: daemon.select,
    providers: daemon.providers,
    active: daemon.effectiveProviderId,
  });
  tourRef.current = {
    openSession,
    setMenuOpen,
    setCarouselOpen,
    setCommandsOpen,
    setNewChatOpen,
    setConnectionOpen,
    sessions: drawerProjection.rows,
    select: daemon.select,
    providers: daemon.providers,
    active: daemon.effectiveProviderId,
  };
  useEffect(() => {
    if (!__DEV__ || process.env.EXPO_PUBLIC_DEV_TOUR !== "1" || daemon.status !== "online") return;
    const t = tourRef;
    const steps: [string, () => void][] = [
      ["openMenu", () => t.current.setMenuOpen(true)],
      [
        "openChat",
        () => {
          const s = t.current.sessions[0];
          if (s) t.current.openSession(s.id);
        },
      ],
      ["openMenu2", () => t.current.setMenuOpen(true)],
      [
        "openChat2",
        () => {
          const s = t.current.sessions[1] ?? t.current.sessions[0];
          if (s) t.current.openSession(s.id);
        },
      ],
      ["openCarousel", () => t.current.setCarouselOpen(true)],
      ["closeCarousel", () => t.current.setCarouselOpen(false)],
      [
        "switchAgent",
        () => {
          const other = t.current.providers.find((p) => p.id !== t.current.active);
          if (other) t.current.select(other.id);
        },
      ],
      [
        "switchBack",
        () => {
          const other = t.current.providers.find((p) => p.id !== t.current.active);
          if (other) t.current.select(other.id);
        },
      ],
      ["openCommands", () => t.current.setCommandsOpen(true)],
      ["closeCommands", () => t.current.setCommandsOpen(false)],
      ["openNewChat", () => t.current.setNewChatOpen(true)],
      ["closeNewChat", () => t.current.setNewChatOpen(false)],
      ["openConnection", () => t.current.setConnectionOpen(true)],
      ["closeConnection", () => t.current.setConnectionOpen(false)],
    ];
    const timers = steps.map(([name, run], i) =>
      setTimeout(
        () => {
          console.log(`PEWTOUR ${name} ${Date.now()}`);
          haptics.tap();
          run();
        },
        6000 + i * 3500,
      ),
    );
    return () => timers.forEach(clearTimeout);
  }, [daemon.status]);

  const closeCommands = useCallback(() => setCommandsOpen(false), []);

  // Stable across renders: the transcript's cells memo on this callback, and a
  // fresh identity per render would re-render every turn on every chunk.
  const openThought = useCallback((text: string) => {
    Keyboard.dismiss();
    setThought(text);
  }, []);
  const closeThought = useCallback(() => setThought(null), []);

  const goals = useGoalControls({
    daemon,
    activeId,
    composer,
    devSheet,
    setMenuOpen,
    launchingGoal,
    setLaunchingGoal,
    setNewGoalPrefill,
    setNewGoalOpen,
  });
  const {
    gg,
    refreshGoals,
    openSessionId,
    queuedHere,
    shownTurns,
    cancelQueued,
    planHere,
    stripsHere,
    openChecklist,
    openTasks,
    ggAgent,
    autopilotOffered,
    autopilotOn,
    autopilotReviewing,
    toggleAutopilot,
    openGoal,
    deleteGoal,
    openNewGoal,
  } = goals;
  const restoring = Boolean(daemon.restoreTarget) && daemon.loadingSession;
  useEffect(() => {
    if (!restoring) {
      setRestoreHold(false);
      return;
    }
    setRestoreHold(true);
    const t = setTimeout(() => setRestoreHold(false), RESTORE_HOLD_MS);
    return () => clearTimeout(t);
  }, [restoring]);
  const holdingRestore = restoring && restoreHold;
  useDevSheetCycle(devSheet, {
    setConnectionOpen,
    setContextOpen,
    setPicker,
    setCommandsOpen,
    setAttachOpen,
    setNewChatOpen,
    setThought,
    setCarouselOpen,
    setMenuOpen,
  });
  const composerSelectors = useMemo<ComposerSelector[]>(
    () => [
      ...(model
        ? [
            {
              id: "model",
              value: "Model",
              label: `Model: ${valueName(model) ?? "Not reported"}${level ? `, ${valueName(level)}` : ""}`,
              onPress: (anchor: ComposerAnchor) => openComposerPicker("model", anchor),
            },
          ]
        : []),
      ...(mode && !ggAgent
        ? [
            {
              id: "mode",
              value: valueName(mode) ?? mode.name,
              label: `${mode.name}: ${valueName(mode) ?? "Not reported"}`,
              onPress: (anchor: ComposerAnchor) => openComposerPicker("mode", anchor),
            },
          ]
        : []),
      ...(autopilotOffered
        ? [
            {
              id: "autopilot",
              value: autopilotReviewing ? "Reviewing…" : "Autopilot",
              label: autopilotReviewing ? "Autopilot, Ken is reviewing" : "Autopilot",
              toggle: { on: autopilotOn },
              onPress: toggleAutopilot,
            },
          ]
        : []),
    ],
    [
      model,
      mode,
      level,
      ggAgent,
      autopilotOffered,
      autopilotOn,
      autopilotReviewing,
      toggleAutopilot,
      openComposerPicker,
    ],
  );

  const answerPermission = useCallback(
    (requestId: string, optionId: string, deny: boolean) => {
      if (deny) haptics.warned();
      else haptics.sent();
      answerDaemon(requestId, optionId);
    },
    [answerDaemon],
  );

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
      <AgentColorProvider value={agentInk}>
        <View style={styles.root}>
          <StatusBar style="light" />

          <GestureDetector gesture={drawerSwipe}>
            <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
              <Sidebar
                open={menuOpen}
                providers={daemon.providers}
                sessions={drawerProjection.rows}
                activeProviderId={active?.id}
                activeSessionId={daemon.sessionId}
                // Selecting an app refilters the history in place. The drawer stays
                // open so you can pick a conversation from that app straight after —
                // closing here would make choosing an app cost two trips.
                onSelectProvider={pickAgent}
                onOpenSession={openSession}
                onNewConversation={newConversation}
                // Which project the history is narrowed to, and where the next
                // conversation will open.
                projects={projects}
                selectedProjectPath={selectedProjectPath}
                onSelectProject={selectProject}
                historyLoading={daemon.loadingSessions}
                reduceMotion={reduceMotion}
                machineLabel={daemon.machineName ?? "Your computer"}
                machineRemote={pairing.remote}
                connectionStatus={daemon.status}
                update={daemon.update}
                onOpenConnection={openConnection}
                onClose={closeMenu}
                goals={
                  isGoalsProvider(activeId) && daemon.hasGgCoder
                    ? {
                        list: gg.goals,
                        loading: gg.goalsLoading,
                        error: gg.goalsError,
                        onRefresh: refreshGoals,
                        onOpen: openGoal,
                        onDelete: deleteGoal,
                        onNew: openNewGoal,
                      }
                    : undefined
                }
              />
            </View>
          </GestureDetector>

          {/* The conversation pane. Slides right to reveal the drawer beneath. */}
          <Reanimated.View style={[styles.pane, paneSlide]}>
            {/* Starts below the nav: this strip is the hit target for anything it
          covers, and over the nav it would swallow taps on the menu button. */}
            {!menuOpen && (
              <GestureDetector gesture={edgeSwipeClosed}>
                <View style={[styles.edgeSwipe, { top: insets.top + navHeight }]} />
              </GestureDetector>
            )}
            {/* Full-bleed on both edges: the thread runs behind the status bar and
          down to the home indicator, and a CanvasCover covers each of those
          regions, so content fades out into the canvas colour at both ends
          rather than meeting a solid band. The dock carries the bottom inset
          itself. */}
            {/* The canvas's dot grid, behind home and every conversation, as on
          onboarding, the agent switcher and calls. Drawn once (a static
          picture), so it costs nothing per frame. */}
            <DotGrid />
            <SafeAreaView style={styles.paneInner} edges={[]}>
              <ScreenTopBar
                daemon={daemon}
                goals={goals}
                insets={insets}
                navHeight={navHeight}
                setNavHeight={setNavHeight}
                setMenuOpen={setMenuOpen}
                onNewChat={openNewFromBar}
                onHome={!inThread && !daemon.restoreTarget && !onHome ? goHome : undefined}
                // Calls are about a conversation: not offered on home.
                onTalk={talkVisible(voice.knowledge) && !onHome ? talk : undefined}
                onTalkHold={talkVisible(voice.knowledge) && !onHome ? talkSettings : undefined}
                talkArmed={talkArmed}
                sessionTitle={sessionTitle}
                inThread={inThread}
                holdingRestore={holdingRestore}
                active={active}
              />

              {/* The one thing the keyboard moves: the thread and the dock ride up as a
          single transform, so the gap between them never changes and nothing
          re-lays out on the keyboard's clock. */}
              <Reanimated.View style={[styles.body, keyboard.pane]}>
                {inThread || daemon.restoreTarget ? (
                  // Remounted per conversation so `startRenderingFromBottom` re-arms:
                  // each transcript must open on its own newest message, not on the
                  // scroll offset the previous one happened to be left at.
                  <ChatThread
                    key={threadKey}
                    ref={scroller}
                    turns={holdingRestore ? NO_TURNS : shownTurns}
                    activeStream={daemon.activeStream}
                    restore={
                      launching
                        ? {
                            title: launchingGoal!,
                            state: "starting",
                            onRetry: NOOP,
                          }
                        : daemon.restoreTarget
                          ? {
                              title: daemon.restoreTarget.title,
                              state: restorePresentation(
                                daemon.restoreTarget,
                                daemon.loadingSession,
                                daemon.restoreError,
                                holdingRestore ? 0 : daemon.turns.length,
                                daemon.status,
                              ),
                              error: daemon.restoreError,
                              onRetry: () => daemon.openSession(daemon.restoreTarget!.id),
                            }
                          : undefined
                    }
                    threadTop={threadTop}
                    threadBottom={threadBottom}
                    working={working && !daemon.loadingSession && !daemon.restoreError}
                    receipt={daemon.receipt}
                    indicatorTop={insets.top + navHeight}
                    indicatorBottom={dockHeight + stripsHeight}
                    onAtBottomChange={setAtBottom}
                    onOpenThought={openThought}
                    onRetry={retrySend}
                  />
                ) : daemon.loadingSession ? null : onHome ? (
                  <HomeDashboard
                    home={devHome ?? dashboard}
                    link={homeLink(daemon.status, daemon.unreachable)}
                    onFirstPaint={onFirstPaint}
                    fatal={daemon.fatal}
                    agents={
                      daemon.providers.length > 0
                        ? daemon.providers.filter((p) => p.available).length
                        : undefined
                    }
                    color={active?.color}
                    // Online, the wait is for the computer's answer (`heard`),
                    // not for the socket: it opens a second before anything
                    // arrives, and home revealed an empty list in that second.
                    // Capped, so an agent that never answers cannot hold it.
                    settled={
                      homeWaited &&
                      (online
                        ? daemon.heard || offlineWaited
                        : everOnline || offlineWaited || Boolean(daemon.fatal))
                    }
                    heard={daemon.heard}
                    top={threadTop}
                    bottom={insets.bottom + theme.space(2)}
                    onOpen={openSession}
                    onPressPew={openCarousel}
                  />
                ) : (
                  // A new conversation, its project and agent chosen: Pew names both;
                  // tapping it switches agent, as everywhere.
                  <HomeView
                    daemon={daemon}
                    keyboard={keyboard}
                    active={active}
                    homeWaited={homeWaited}
                    reduceMotion={reduceMotion}
                    homeStatus={homeStatus}
                    openCarousel={openCarousel}
                    pewSmiling={pewSmiling}
                    greeting={greeting}
                    emptyReason={emptyReason}
                    hint="Tap Pew to switch agent"
                  />
                )}

                {/* Home has no composer. Hidden rather than unmounted: the dock owns
            the draft, and a banner reply that must reopen its conversation
            first leaves its text there. */}
                <View
                  style={[styles.dockOverlay, { bottom: 0 }, onHome && hiddenDock]}
                  pointerEvents={onHome ? "none" : "box-none"}
                  accessibilityElementsHidden={onHome}
                  importantForAccessibility={onHome ? "no-hide-descendants" : "auto"}
                >
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
                      <DotGlyph name="down" size={16} />
                    </CircleButton>
                  </Animated.View>
                  {dockHeight > 0 && (
                    <CanvasCover
                      edge="bottom"
                      height={dockHeight + stripsHeight}
                      style={styles.dockCover}
                    />
                  )}
                  {/* The dock keeps the composer even while an approval is pending:
              the request is its own blocking sheet now, so swapping this out
              under it would only resize the thread behind a covered surface.

              It owns the draft, so typing re-renders this subtree and not the
              whole app. That is what leaves the JS thread free for the
              composer's own growth animation while a line wraps. */}
                  <View
                    onLayout={(e) => {
                      const height = Math.round(e.nativeEvent.layout.height);
                      setStripsHeight((prev) => (prev === height ? prev : height));
                    }}
                  >
                    {/* GG's Checklist / Plan chips ride the composer's context row now. */}
                    <QueuedStrip messages={queuedHere} onCancel={cancelQueued} />
                  </View>
                  <ComposerDock
                    ref={composer}
                    style={[
                      styles.dock,
                      // Constant. The spacer below the body carries the keyboard, and it
                      // already gives this clearance back, so the composer keeps the
                      // same gap above either boundary without re-laying out.
                      { paddingBottom: insets.bottom + theme.space(2) },
                    ]}
                    // Settled heights only. The dock reports once its growth animation
                    // has stopped, not on every frame of it — measured at roughly one
                    // layout pass per two pixels, which turned a single wrapped line
                    // into about ten re-renders of this whole component, each one
                    // rebuilding the thread's spacers and re-running its follow-scroll
                    // on the exact frames the composer was trying to animate.
                    onHeightSettled={(height) => {
                      // Recorded against the state it was measured in, and only when it
                      // actually changed — the keyboard's own animation causes layout
                      // passes that have nothing to do with the draft.
                      setDockHeights((prev) => recordDockHeight(prev, typing, height));
                    }}
                    typing={typing}
                    workspace={
                      isGoalsProvider(active?.id) && !openSessionId ? undefined : daemon.workspace
                    }
                    usage={daemon.usage}
                    showCommands={daemon.commands.length > 0}
                    onCommands={openCommands}
                    onProjectDetails={openContext}
                    onChecklist={stripsHere.checklist ? openChecklist : undefined}
                    onTasks={stripsHere.tasks ? openTasks : undefined}
                    planMode={stripsHere.plan && planHere?.planMode === true}
                    selectors={composerSelectors}
                    onSend={send}
                    busy={showsStop(daemon)}
                    onStop={daemon.cancel}
                    // Never locked by the network. A dead socket used to disable the
                    // whole composer — no keyboard, no typing, nothing — which is the
                    // one moment a phone is most likely to be in a tunnel and the user
                    // most wants to get a thought down. Offline sends are queued and
                    // delivered on reconnect (see `outbox.ts`), so the only thing that
                    // still locks it is a refusal retrying cannot fix: a rotated key or
                    // a version mismatch, where nothing typed here could ever go.
                    editable={!daemon.fatal}
                    placeholder={
                      dictation.listening
                        ? "Listening..."
                        : daemon.status !== "online"
                          ? "Offline. Sends when you reconnect"
                          : !active
                            ? "Waiting for an agent..."
                            : isGoalsProvider(active.id)
                              ? openSessionId
                                ? "Message GG Goals..."
                                : "Describe the goal..."
                              : "Build anything..."
                    }
                    attachments={attachments}
                    onAttach={openAttach}
                    onRemoveAttachment={removeAttachment}
                    dictation={dictation}
                  />
                </View>
              </Reanimated.View>

              {/* Outside the lifted pane: a sheet belongs to the screen's bottom edge,
          not to the composer, so it must not ride up with the keyboard. */}
              <ContextDetailsSheet
                visible={contextOpen}
                workspace={daemon.workspace}
                usage={daemon.usage}
                inConversation={daemon.sessionId !== undefined}
                onClose={closeContext}
              />
              <ConnectionSheet
                visible={connectionOpen}
                machineLabel={daemon.machineName ?? "Your computer"}
                machineRemote={pairing.remote}
                status={daemon.status}
                update={daemon.update}
                onClose={closeConnection}
                onUnpair={onUnpair}
                alerts={{
                  value: alertsRowValue(alerts.status),
                  onPress:
                    alerts.status === "granted"
                      ? () => void Linking.openSettings().catch(() => {})
                      : alertsFromRow,
                }}
                voice={
                  voiceSettingsVisible(voice.knowledge) && voice.knowledge.kind === "known"
                    ? {
                        line: callsLine(voice.knowledge.status, voiceNow),
                        onOpen: () => {
                          setConnectionOpen(false);
                          setVoiceSettingsOpen(true);
                        },
                      }
                    : undefined
                }
              />
              <VoiceSettingsSheet
                visible={voiceSettingsOpen}
                knowledge={voice.knowledge}
                onClose={closeVoiceSheet}
                onLogin={voice.login}
                onPrefs={voice.setPrefs}
                onArm={voice.arm}
                onForget={voice.forgetHistory}
                sessionId={daemon.sessionId}
                forCall={voiceForCall}
                onCall={callFromVoiceSheet}
                consented={voiceConsent === true}
                onAgree={agreeToVoice}
                alertsGranted={alerts.status === "granted"}
                onNeedAlerts={alertsForRing}
              />
              <AlertsCard card={alerts.card} onAllow={alerts.allow} onNotNow={alerts.notNow} />
              <CallScreen
                call={voice.call}
                board={voice.board}
                providers={daemon.providers}
                onHangUp={voice.hangUp}
                onMute={voice.setMuted}
                onDismiss={voice.dismiss}
                onRetry={() => {
                  const focus = voice.call.focus;
                  voice.dismiss();
                  startCall(focus);
                }}
                onAnswer={voice.answerOnScreen}
                color={active?.color}
                onInterrupt={voice.interrupt}
                micLevel={voice.micLevel}
                speech={voice.speech}
              />
              <CommandSheet
                visible={commandsOpen}
                commands={daemon.commands}
                onSelect={pickCommand}
                onClose={closeCommands}
              />

              <NewChatSheet
                visible={newChatOpen}
                currentFolder={daemon.workspace?.folder}
                currentCwd={selectedProjectPath ?? daemon.workspace?.cwd}
                projects={projects}
                agents={carouselAgents}
                agentId={activeId}
                onPickAgent={pickAgent}
                onStart={startNewChat}
                onClose={closeNewChat}
                browse={daemon.browse}
                onBrowse={daemon.browseWorkspaces}
              />

              <AttachmentSheet
                visible={attachOpen}
                onSelect={pickAttachment}
                onClose={closeAttach}
              />

              <ThoughtSheet
                visible={thought !== null}
                text={thought ?? ""}
                onClose={closeThought}
              />
              {carouselOpen && carouselAgents.length > 0 && (
                <AgentCarousel
                  agents={carouselAgents}
                  currentId={activeId}
                  onSelect={daemon.select}
                  onClose={closeCarousel}
                  arriveSmiling
                />
              )}

              {/* One picker, pointed at whichever pill opened it. The mode selector is
          excluded from the model menu so each pill owns exactly one list. */}
              <ConfigPicker
                visible={picker !== null}
                onClose={closePicker}
                anchorX={pickerAnchor?.x}
                anchorY={pickerAnchor?.y}
                options={
                  picker === "mode"
                    ? mode
                      ? [mode]
                      : []
                    : daemon.configOptions.filter((option) => option.id !== mode?.id)
                }
                onSelect={daemon.setConfig}
              />

              <GoalSheets
                onTalk={talkable ? talkAbout : undefined}
                daemon={daemon}
                goals={goals}
                newGoalOpen={newGoalOpen}
                newGoalPrefill={newGoalPrefill}
                answerPermission={answerPermission}
                send={send}
              />

              {/* While the drawer is open the pane itself is the way back: tapping
          anywhere on it closes, which matches the push metaphor better than a
          separate dimming layer would. */}
              {menuOpen && (
                // The gesture lives on this wrapper rather than the Pressable, so a drag
                // and a tap stay two separate things: the detector claims the touch once
                // it moves horizontally, and the Pressable keeps everything else.
                <GestureDetector gesture={edgeSwipeOpen}>
                  <View style={StyleSheet.absoluteFill}>
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
                </GestureDetector>
              )}
            </SafeAreaView>
          </Reanimated.View>
        </View>
      </AgentColorProvider>
    </ImageResolverProvider>
  );
}
