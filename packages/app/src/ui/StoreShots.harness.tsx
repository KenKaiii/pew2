/**
 * Dev-only harness that poses the app for App Store screenshots.
 *
 * Screenshots have to be captured from a real device render — blur, gradients,
 * font hinting and the safe-area insets all differ enough on the web build that
 * a browser capture would not be an honest picture of the app. But the three
 * screens worth showing all sit behind a pairing step and a live agent, which
 * cannot be driven from a script when synthetic input is unavailable.
 *
 * So this mounts the real components with stand-in data instead, and rotates
 * through the three poses on a timer so each can be captured with
 * `simctl io screenshot` without anything needing to be tapped.
 *
 * Not reachable from the app. Point index.ts here, build to a simulator,
 * capture, then put index.ts back.
 */
import { useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { Ionicons } from "@expo/vector-icons";
import { theme } from "../theme";
import { ChatThread, type ChatThreadRef } from "./ChatThread";
import { Composer } from "./Composer";
import { Sidebar, DRAWER_WIDTH } from "./Sidebar";
import { NewChatSheet } from "./NewChatSheet";
import { CircleButton } from "./controls";
import type { Project } from "../projects";
import type { Provider, Session, Turn } from "../useDaemon";

/** How long each pose holds. Long enough to screenshot without racing it. */
const HOLD_MS = 7000;

/**
 * Fixed start time for the "working" indicator.
 *
 * Read once at module load rather than during render: `Date.now()` in a render
 * body re-reads on every re-render, so the elapsed counter would show a
 * different number in each capture and the three shots would disagree about
 * how long the same task had been running.
 */
const TURN_STARTED_AT = Date.now() - 24_000;

const PROVIDERS: Provider[] = [
  { id: "claude-code", name: "Claude Code", description: "", available: true, color: "#d97757" },
  { id: "codex", name: "Codex", description: "", available: true, color: "#10a37f" },
  { id: "gemini-cli", name: "Gemini CLI", description: "", available: true, color: "#3d9bf5" },
  { id: "opencode", name: "OpenCode", description: "", available: true, color: "#c9a227" },
];

const PROJECTS: Project[] = [
  { path: "/Users/k/code/storefront", name: "storefront", sessions: 18 },
  { path: "/Users/k/code/pew2", name: "pew2", sessions: 24 },
  { path: "/Users/k/code/notes-api", name: "notes-api", sessions: 6 },
];

const SESSIONS: Session[] = [
  "Fix the checkout total when a coupon expires mid-session",
  "Add a health endpoint and wire it into the deploy check",
  "Why is the image upload timing out over cellular?",
  "Rename the legacy user fields and update every caller",
  "Draft the release notes for 1.2",
].map((title, index) => ({
  id: `s${index}`,
  providerId: "claude-code",
  title,
  startedAt: 0,
  turns: [],
  configOptions: [],
  cwd: PROJECTS[index % PROJECTS.length]!.path,
  messageCount: 4 + index * 3,
  busy: index === 0,
  unread: index === 1,
}));

/**
 * A short exchange that shows the thing the app is for: a real instruction, the
 * agent's own explanation, and work still running underneath.
 */
const TURNS: Turn[] = [
  {
    id: "t0",
    role: "user",
    text: "Morning. What did you get through last night?",
  },
  {
    id: "t0b",
    role: "agent",
    text: "Finished the cart refactor and pushed it, and all 240 tests pass. One thing I left for you: the coupon expiry looks wrong to me.",
  },
  {
    id: "t1",
    role: "user",
    text: "The checkout total is wrong when a coupon expires while someone is still on the page. Find it and fix it.",
  },
  {
    id: "t2",
    role: "agent",
    text: "Found it. `applyCoupon` caches the discount on the cart when the coupon is first applied, but nothing re-checks `expiresAt` before the total is rendered, so an expired coupon keeps its discount until the page reloads.\n\nI moved the expiry check into `cartTotal` so it runs on every read, and left `applyCoupon` alone — the cache is still worth having.",
  },
  {
    id: "t3",
    role: "user",
    text: "Good. Add a test for it.",
  },
];

/** The top bar, matching the app's own: menu, connection, model, new chat. */
function NavBar({ onMenu }: { onMenu: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.nav, { paddingTop: insets.top + theme.space(1) }]}>
      <CircleButton label="Menu" onPress={onMenu}>
        <Ionicons name="menu" size={20} color={theme.color.text} />
      </CircleButton>
      <View style={styles.pill}>
        <Text style={styles.pillText} numberOfLines={1}>
          Sonnet 4.5
        </Text>
        <Ionicons name="chevron-down" size={13} color={theme.color.textDim} />
      </View>
      <View style={styles.pill}>
        <Text style={styles.pillText} numberOfLines={1}>
          Accept edits
        </Text>
        <Ionicons name="chevron-down" size={13} color={theme.color.textDim} />
      </View>
      <View style={styles.navSpacer} />
      <CircleButton label="New conversation" onPress={() => {}}>
        <Ionicons name="create-outline" size={18} color={theme.color.text} />
      </CircleButton>
    </View>
  );
}

/** Pose one and two share the conversation behind them; only the drawer moves. */
function Conversation({ drawerOpen }: { drawerOpen: boolean }) {
  const insets = useSafeAreaInsets();
  const list = useRef<ChatThreadRef>(null);
  const navHeight = insets.top + 64;
  const dockHeight = 96 + insets.bottom;

  return (
    <View style={styles.root}>
      <Sidebar
        open={drawerOpen}
        providers={PROVIDERS}
        sessions={SESSIONS}
        activeProviderId="claude-code"
        activeSessionId="s0"
        onSelectProvider={() => {}}
        onOpenSession={() => {}}
        onNewConversation={() => {}}
        projects={PROJECTS}
        selectedProjectPath="/Users/k/code/storefront"
        onSelectProject={() => {}}
        historyLoading={false}
        reduceMotion={false}
        machineLabel="studio.local"
        machineRemote
        connectionStatus="online"
        onUnpair={() => {}}
      />

      <View
        style={[
          styles.pane,
          // Off-screen entirely when the drawer is showing. Sliding it only
          // partway left its edge on top of the drawer's right side, cutting
          // every chat title mid-word.
          drawerOpen && { transform: [{ translateX: DRAWER_WIDTH + 400 }] },
        ]}
      >
        <NavBar onMenu={() => {}} />
        <ChatThread
          ref={list}
          turns={TURNS}
          threadTop={navHeight}
          threadBottom={dockHeight + theme.space(2)}
          // The agent is mid-task, which is the state the app exists for: the
          // work carries on while the phone is somewhere else.
          working
          activity={{
            startedAt: TURN_STARTED_AT,
            tools: [
              { id: "a", title: "Reading cart/total.ts", kind: "read", status: "completed" },
              { id: "b", title: "Editing cart/total.ts", kind: "edit", status: "completed" },
              { id: "c", title: "Running the checkout tests", kind: "execute", status: "in_progress" },
            ],
            speaking: false,
          }}
          indicatorTop={navHeight}
          indicatorBottom={dockHeight}
          onAtBottomChange={() => {}}
          onOpenThought={() => {}}
        />
        <View style={styles.dock}>
          <Composer value="" onChangeText={() => {}} onSend={() => {}} />
        </View>
      </View>
    </View>
  );
}

/** Pose three: picking the project a new conversation opens in. */
function ProjectPicker() {
  return (
    <View style={styles.root}>
      <Conversation drawerOpen={false} />
      <NewChatSheet
        visible
        currentFolder="storefront"
        currentCwd="/Users/k/code/storefront"
        projects={PROJECTS}
        onStart={() => {}}
        onClose={() => {}}
      />
    </View>
  );
}

export default function StoreShotsHarness() {
  const [pose, setPose] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => setPose((p) => (p + 1) % 3), HOLD_MS);
    return () => clearInterval(timer);
  }, []);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      {pose === 0 && <Conversation drawerOpen={false} />}
      {pose === 1 && <Conversation drawerOpen />}
      {pose === 2 && <ProjectPicker />}
      {/* A marker only the capture script reads, so a shot taken mid-rotation
          can be told apart from the pose it was meant to be. Sits in the corner
          where the crop for 6.5" removes it. */}
      <View style={styles.marker} pointerEvents="none">
        <Text style={styles.markerText}>{pose}</Text>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  pane: { flex: 1, backgroundColor: theme.color.bg },
  nav: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(2),
    paddingHorizontal: theme.gutter,
    paddingBottom: theme.space(2),
  },
  navSpacer: { flex: 1 },
  pill: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space(1),
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
    borderRadius: 999,
    backgroundColor: theme.color.surface,
  },
  pillText: { color: theme.color.textDim, fontSize: 13 },
  dock: { position: "absolute", left: 0, right: 0, bottom: 0 },
  marker: { position: "absolute", left: 2, bottom: 2, opacity: 0.35 },
  markerText: { color: theme.color.textDim, fontSize: 9 },
});
