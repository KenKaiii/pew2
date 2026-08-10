/**
 * Dev-only visual harness for the message sheet.
 *
 * Exists for the three things the sheet cannot be driven into on demand from a
 * real conversation, because each needs a message of a particular shape:
 *
 * 1. **One line.** The card is a fixed height, so a short message has to sit in
 *    a mostly empty card without the Copy rail floating up to meet it.
 * 2. **A long markdown reply.** The text is shown as source, so headings and a
 *    fenced block are just more lines — the reading area must scroll while the
 *    rail stays pinned to the card's bottom edge and unclipped by its radius.
 * 3. **3000 characters with no space in them.** The one input that can break the
 *    layout sideways rather than downwards: nothing in an unbroken run gives the
 *    text engine a wrap opportunity, so if the reading area can be widened by
 *    its content, the card overflows horizontally and the rail goes with it.
 *
 * The vertical rails mark the gutter the sheet insets its card by. The card
 * sits inside them; anything crossing one has escaped sideways.
 *
 * Not reachable from the app; point `index.ts` here. **Run it on iOS, not web**
 * — `expo start --web` renders any `Sheet` blank, dying on `WorkletsError:
 * createSerializableObject should never be called in JSWorklets`. That is not
 * specific to this harness (`NewChatSheet.harness` does the same), so use
 * `npx expo run:ios`.
 *
 * One trap when screenshotting: fast refresh preserves state, so editing a
 * fixture does not move the selection and leaves the sheet's spring
 * mid-animation. Relaunch the app between captures rather than trusting a
 * reload — `xcrun simctl terminate booted <bundle id>` then `launch`.
 */
import { useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { theme } from "../theme";
import { MessageSheet } from "./MessageSheet";

const ONE_LINE = "Done — the failing test was a stale mock, not the reducer.";

const LONG_REPLY = `## What I changed

The probe cache was memoised for the daemon's lifetime, so a list read once at
boot was still being served days later. It now revalidates on a clock.

### The two paths

1. \`probeProvider\` serves the cached answer and kicks a refresh if it is stale.
2. The disk-serve path no longer delegates that refresh to \`warmProvider\`,
   which returns early whenever a spare is already parked.

\`\`\`ts
private revalidateIfStale(providerId: string) {
  const at = this.probedAt.get(providerId);
  if (at !== undefined && Date.now() - at < Daemon.PROBE_TTL_MS) return;
  void this.refreshCapabilities(providerId);
}
\`\`\`

A refresh runs **beside** the cached entry rather than replacing it up front, so
a reader arriving mid-refresh is still answered instantly and a refresh that
fails leaves the last good answer exactly where it was.

### What to watch

- \`PROBE_TTL_MS\` is 60s: the ask that matters is the one on reconnect.
- A failed probe backs off a full interval instead of respawning per ask.
- The spawn is not wasted — the probe leaves its process parked as the spare.

Restart the running daemon; it still holds the old promise in memory.`;

/**
 * One token, no spaces, no punctuation to break on. A base64 blob or a minified
 * bundle pasted into chat arrives exactly like this.
 */
const UNBROKEN = "x7Qk".repeat(750);

const FIXTURES = [
  { key: "short", label: "one line", text: ONE_LINE },
  { key: "long", label: "long markdown", text: LONG_REPLY },
  { key: "unbroken", label: `unbroken ${UNBROKEN.length}ch`, text: UNBROKEN },
] as const;

export default function MessageSheetHarness() {
  const [index, setIndex] = useState(0);
  const [visible, setVisible] = useState(true);
  const fixture = FIXTURES[index];

  return (
    <GestureHandlerRootView style={styles.root}>
      <SafeAreaProvider>
        <StatusBar style="light" />
        <SafeAreaView style={styles.screen}>
          <Text style={styles.heading}>Message sheet</Text>
          <Text style={styles.body}>
            Showing: {fixture.label} ({fixture.text.length} characters)
          </Text>

          <View style={styles.controls}>
            {FIXTURES.map((item, i) => (
              <Pressable
                key={item.key}
                testID={`fixture-${item.key}`}
                style={[styles.button, i === index && styles.buttonOn]}
                onPress={() => {
                  setIndex(i);
                  setVisible(true);
                }}
              >
                <Text style={styles.buttonText}>{item.label}</Text>
              </Pressable>
            ))}
            <Pressable testID="reopen" style={styles.button} onPress={() => setVisible(true)}>
              <Text style={styles.buttonText}>reopen</Text>
            </Pressable>
          </View>

          {/* The gutter rail, drawn behind the sheet. The card sits at or
              inside these lines; anything crossing one has overflowed
              horizontally, which is the failure the 3000-character fixture
              exists to catch. */}
          <View style={styles.gauge} pointerEvents="none">
            <View style={styles.gaugeEdge} />
            <View style={styles.gaugeEdge} />
          </View>
        </SafeAreaView>

        <MessageSheet visible={visible} text={fixture.text} onClose={() => setVisible(false)} />
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  screen: { flex: 1, backgroundColor: theme.color.bg, padding: theme.space(6), gap: theme.space(3) },
  heading: { color: theme.color.text, fontSize: theme.font.title, fontWeight: "600" },
  body: { color: theme.color.textDim, fontSize: theme.font.body },
  controls: { flexDirection: "row", flexWrap: "wrap", gap: theme.space(2) },
  button: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
  },
  buttonOn: { backgroundColor: theme.color.surfaceRaised },
  buttonText: { color: theme.color.text, fontSize: theme.font.small },
  gauge: {
    ...StyleSheet.absoluteFillObject,
    flexDirection: "row",
    justifyContent: "space-between",
    // The same rail the sheet insets its card by (`marginHorizontal:
    // theme.gutter`). The card renders a little inside it, since the scrim
    // contributes its own inset — so treat these as the outer bound rather
    // than a registration mark.
    paddingHorizontal: theme.gutter,
  },
  gaugeEdge: { width: 1, height: "100%", backgroundColor: theme.color.accent, opacity: 0.5 },
});
