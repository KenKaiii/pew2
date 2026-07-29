/**
 * Dev-only visual harness for the Composer's two states.
 *
 * Focus is hard to drive deterministically from a script, so this renders both
 * states side by side using only the component's public API: an empty composer
 * rests collapsed, one holding text stays expanded. Each sits in a fixed-height
 * slot so a screenshot can be measured against known coordinates.
 *
 * Not reachable from the app. Rendered by temporarily pointing index.ts here.
 */
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { theme } from "../theme";
import { Composer } from "./Composer";

function Slot({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View style={styles.slot}>
      <Text style={styles.label}>{label}</Text>
      <View style={styles.mount}>{children}</View>
    </View>
  );
}

export default function ComposerHarness() {
  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.root}>
        <StatusBar style="light" />

        <Slot label="COLLAPSED">
          <Composer value="" onChangeText={() => {}} onSend={() => {}} />
        </Slot>

        <Slot label="EXPANDED">
          <Composer
            value="Refactor the auth module and add a test covering the concurrent refresh path"
            onChangeText={() => {}}
            onSend={() => {}}
          />
        </Slot>
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: theme.color.bg },
  slot: { paddingHorizontal: theme.gutter, paddingTop: theme.space(3) },
  label: {
    color: theme.color.textDim,
    fontSize: theme.font.tiny,
    letterSpacing: 1,
    paddingBottom: theme.space(2),
  },
  // Fixed height so each composer's own height is measured against a known
  // top edge rather than against the one above it. Kept tight so both slots
  // clear any dev-menu sheet that appears over the lower half of the screen.
  mount: { height: 150, justifyContent: "flex-start" },
});
