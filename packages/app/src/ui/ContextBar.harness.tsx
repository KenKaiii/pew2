/**
 * Dev-only visual harness for the context row.
 *
 * Every combination that actually occurs, stacked at phone width: the row has
 * to survive an agent that reports no usage, a project that is not a repo, a
 * long folder name, and a context window about to compact. Not reachable from
 * the app; point index.ts here and run `npx expo start --web`.
 */
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { theme } from "../theme";
import { ContextBar } from "./ContextBar";

const CASES: Array<{ note: string; props: React.ComponentProps<typeof ContextBar> }> = [
  {
    note: "Everything — real Claude Code reading (21,325 / 1,000,000)",
    props: {
      workspace: { cwd: "/Users/k/gg-projects/pew2", folder: "pew2", repo: true, uncommitted: 9 },
      usage: { used: 21325, size: 1000000 },
      showCommands: true,
      onCommands: () => {},
    },
  },
  {
    note: "High — 78%, accent",
    props: {
      workspace: { cwd: "/Users/k/p/pew2", folder: "pew2", repo: true, uncommitted: 2 },
      usage: { used: 78000, size: 100000 },
      showCommands: true,
      onCommands: () => {},
    },
  },
  {
    note: "Critical — 94%, compaction close",
    props: {
      workspace: { cwd: "/Users/k/p/pew2", folder: "pew2", repo: true, uncommitted: 1 },
      usage: { used: 94000, size: 100000 },
      showCommands: true,
      onCommands: () => {},
    },
  },
  {
    note: "No usage — GG Coder today. Reading omitted, not zeroed",
    props: {
      workspace: { cwd: "/Users/k/p/pew2", folder: "pew2", repo: true, uncommitted: 4 },
      showCommands: true,
      onCommands: () => {},
    },
  },
  {
    note: "Clean tree, no commands",
    props: {
      workspace: { cwd: "/Users/k/p/site", folder: "site", repo: true, uncommitted: 0 },
      usage: { used: 4000, size: 200000 },
      showCommands: false,
      onCommands: () => {},
    },
  },
  {
    note: "Not a repo — no change count at all",
    props: {
      workspace: { cwd: "/Users/k/notes", folder: "notes", repo: false, uncommitted: 0 },
      usage: { used: 120000, size: 200000 },
      showCommands: true,
      onCommands: () => {},
    },
  },
  {
    note: "Long folder name — must not push the row off screen",
    props: {
      workspace: {
        cwd: "/Users/k/work/acme-storefront-migration",
        folder: "acme-storefront-migration",
        repo: true,
        uncommitted: 137,
      },
      usage: { used: 91000, size: 100000 },
      showCommands: true,
      onCommands: () => {},
    },
  },
];

export default function ContextBarHarness() {
  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={styles.screen}>
        {CASES.map((testCase) => (
          <View key={testCase.note} style={styles.case}>
            <Text style={styles.note}>{testCase.note}</Text>
            {/* Phone width, so truncation is exercised honestly. */}
            <View style={styles.phone}>
              <ContextBar {...testCase.props} />
            </View>
          </View>
        ))}
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.bg, padding: theme.space(6), gap: theme.space(5) },
  case: { gap: theme.space(2) },
  note: { color: theme.color.textFaint, fontSize: theme.font.tiny },
  phone: { width: 390 - theme.gutter * 2 },
});
