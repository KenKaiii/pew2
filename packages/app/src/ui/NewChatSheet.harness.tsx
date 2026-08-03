/**
 * Dev-only visual harness for the "New chat" sheet.
 *
 * Renders it over a stand-in conversation so the card, the scrim and the two
 * steps can be checked against the same bottom edge the real sheet uses. Not
 * reachable from the app; point index.ts here and run `npx expo start --web`.
 */
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { theme } from "../theme";
import { NewChatSheet } from "./NewChatSheet";
import type { Project } from "../projects";

const PROJECTS: Project[] = [
  { path: "/Users/k/gg-projects/pew2", name: "pew2", sessions: 24 },
  { path: "/Users/k/gg-projects/kencode-search", name: "kencode-search", sessions: 7 },
  { path: "/Users/k/work/acme-storefront", name: "acme-storefront", sessions: 3 },
  { path: "/Users/k/work/notes", name: "notes", sessions: 1 },
  { path: "/Users/k/work/infra", name: "infra", sessions: 12 },
  { path: "/Users/k/work/scratch", name: "scratch", sessions: 2 },
];

export default function NewChatSheetHarness() {
  const [visible, setVisible] = useState(true);
  const [started, setStarted] = useState<string>("nothing yet");

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={styles.screen}>
        <Text style={styles.heading}>Conversation behind the sheet</Text>
        <Text style={styles.body}>
          The sheet rises from the bottom edge over this. Tap the scrim to dismiss it.
        </Text>
        <Text style={styles.body}>Last start: {started}</Text>
        <Pressable style={styles.button} onPress={() => setVisible(true)}>
          <Text style={styles.buttonText}>Open the sheet</Text>
        </Pressable>
      </View>

      <NewChatSheet
        visible={visible}
        currentFolder="pew2"
        currentCwd="/Users/k/gg-projects/pew2"
        projects={PROJECTS}
        onStart={(cwd) => {
          setStarted(cwd ?? "the agent's last project");
          setVisible(false);
        }}
        onClose={() => setVisible(false)}
      />
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.bg, padding: theme.space(6), gap: theme.space(3) },
  heading: { color: theme.color.text, fontSize: theme.font.title, fontWeight: "600" },
  body: { color: theme.color.textDim, fontSize: theme.font.body },
  button: {
    alignSelf: "flex-start",
    backgroundColor: theme.color.surfaceRaised,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(4),
    paddingVertical: theme.space(3),
  },
  buttonText: { color: theme.color.text, fontSize: theme.font.body },
});
