/**
 * Dev-only visual harness for the Composer's states.
 *
 * Focus is hard to drive deterministically from a script, so these render side
 * by side using only the component's public API: an empty composer rests
 * collapsed, one holding text stays expanded, attachments add a chip row, and
 * dictation lights the mic. Each sits in a fixed-height slot so a screenshot
 * can be measured against known coordinates.
 *
 * Not reachable from the app. Rendered by temporarily pointing index.ts here,
 * and it runs on web (`npx expo start --web`) — which is why anything iOS-only
 * inside the tree has to be optional-called rather than assumed.
 */
import type { ReactNode } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { theme } from "../theme";
import { Composer } from "./Composer";
import type { PendingAttachment } from "../attachments";
import { useDictation, type Dictation } from "./useDictation";

const SAMPLE_ATTACHMENTS: PendingAttachment[] = [
  {
    id: "a",
    name: "Screenshot 2026-08-02 at 18.22.10.png",
    mimeType: "image/png",
    data: "",
    size: 412 * 1024,
  },
  { id: "b", name: "server.log", mimeType: "text/plain", data: "", size: 2048 },
];

const LISTENING: Dictation = {
  available: true,
  listening: true,
  toggle: () => {},
  cancel: () => {},
};

function LiveDictationSlot() {
  const dictation = useDictation({
    draft: () => "",
    onDraftChange: () => {},
    onMessage: () => {},
  });
  return (
    <Slot label={`LIVE MODULE — available: ${String(dictation.available)}`}>
      <Composer value="" onChangeText={() => {}} onSend={() => {}} dictation={dictation} />
    </Slot>
  );
}

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

        {/* Chips push the pill down rather than reshaping it: the file row is
            its own band above the glass. A no-thumbnail file and a long name
            are both here because those are the two that break the layout. */}
        <Slot label="ATTACHMENTS">
          <Composer
            value="what broke here"
            onChangeText={() => {}}
            onSend={() => {}}
            attachments={SAMPLE_ATTACHMENTS}
            onAttach={() => {}}
            onRemoveAttachment={() => {}}
          />
        </Slot>

        <Slot label="LISTENING">
          <Composer
            value=""
            onChangeText={() => {}}
            onSend={() => {}}
            dictation={LISTENING}
          />
        </Slot>

        {/* The real hook, not a stub: this is the only way to see whether the
            native speech module actually loaded. A visible mic here means
            `speechAvailable()` found a recogniser; a dimmed one means it did
            not, which is exactly what Expo Go looks like. */}
        <LiveDictationSlot />
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
