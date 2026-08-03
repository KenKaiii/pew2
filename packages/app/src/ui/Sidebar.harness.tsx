/**
 * Dev-only visual harness for the drawer, including the project selector.
 *
 * Two mounts side by side: the drawer at rest showing every project, and the
 * same drawer with its menu open, so the dropdown's alignment against the app
 * chips and the "Latest chats" rail can be measured rather than guessed.
 *
 * Not reachable from the app. Rendered by temporarily pointing index.ts here,
 * and it runs on web (`npx expo start --web`) — which is why anything iOS-only
 * inside the tree has to be optional-called rather than assumed.
 */
import { useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { theme } from "../theme";
import { Sidebar, DRAWER_WIDTH } from "./Sidebar";
import type { Project } from "../projects";
import type { Provider, Session } from "../useDaemon";

const PROVIDERS: Provider[] = [
  { id: "claude-code", name: "Claude Code", description: "", available: true, color: "#d97757" },
  { id: "codex", name: "Codex", description: "", available: true, color: "#10a37f" },
  { id: "ggcoder", name: "GG Coder", description: "", available: true, color: "#3d9bf5" },
];

const PROJECTS: Project[] = [
  { path: "/Users/k/gg-projects/pew2", name: "pew2", sessions: 24 },
  { path: "/Users/k/gg-projects/kencode-search", name: "kencode-search", sessions: 7 },
  { path: "/Users/k/work/acme-storefront", name: "acme-storefront", sessions: 3 },
  { path: "/Users/k/work/notes", name: "notes", sessions: 1 },
];

const SESSIONS: Session[] = [
  "Fix the drawer jumping when the keyboard closes",
  "Add a project selector to the sidebar",
  "Why does the relay drop websocket upgrades locally?",
  "Rename folderName and update its callers",
  "Draft the release notes for 0.4",
].map((title, index) => ({
  id: `s${index}`,
  providerId: "claude-code",
  title,
  startedAt: 0,
  turns: [],
  configOptions: [],
  cwd: PROJECTS[index % PROJECTS.length]!.path,
  messageCount: 6 + index * 3,
  busy: index === 0,
  unread: index === 1,
}));

function Mount({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={styles.slot}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.mount}>{children}</View>
    </View>
  );
}

function Drawer({ initialPath }: { initialPath?: string }) {
  const [path, setPath] = useState<string | undefined>(initialPath);
  return (
    <Sidebar
      open
      providers={PROVIDERS}
      sessions={SESSIONS}
      activeProviderId="claude-code"
      activeSessionId="s1"
      onSelectProvider={() => {}}
      onOpenSession={() => {}}
      onNewConversation={() => {}}
      projects={PROJECTS}
      selectedProjectPath={path}
      onSelectProject={setPath}
      machineLabel="studio.local:8787"
      machineRemote={false}
      connectionStatus="online"
      onUnpair={() => {}}
    />
  );
}

export default function SidebarHarness() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={styles.screen}>
        <Mount label="ALL PROJECTS (default)">
          <Drawer />
        </Mount>
        <Mount label="ONE PROJECT SELECTED">
          <Drawer initialPath="/Users/k/gg-projects/pew2" />
        </Mount>
      </View>
      <Text style={styles.hint}>Tap the project row in either drawer to open the menu.</Text>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    flexDirection: "row",
    gap: theme.space(6),
    padding: theme.space(6),
    backgroundColor: theme.color.bg,
  },
  slot: { width: DRAWER_WIDTH, height: 760 },
  label: {
    color: theme.color.textDim,
    fontSize: theme.font.tiny,
    letterSpacing: 1,
    paddingBottom: theme.space(2),
  },
  mount: { flex: 1, overflow: "hidden" },
  hint: { color: theme.color.textFaint, fontSize: theme.font.tiny, padding: theme.space(4) },
});
