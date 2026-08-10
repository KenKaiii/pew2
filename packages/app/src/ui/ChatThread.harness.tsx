/**
 * Dev-only visual harness for the transcript.
 *
 * Exists to check one thing the app cannot easily be driven into on demand: the
 * bottom boundary. The composer is an overlay pinned to the bottom edge, so the
 * list has to reserve exactly its height — and the failure is silent, because a
 * message that ends up behind a translucent dock is still *there*, just
 * unreadable. Rendering a stand-in dock of a known height over a transcript of
 * known length makes that visible.
 *
 * Not reachable from the app; point index.ts here and run `npx expo start --web`.
 */
import { useRef, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { theme } from "../theme";
import { ChatThread, type ChatThreadRef } from "./ChatThread";
import type { Turn } from "../useDaemon";

const DOCK_HEIGHT = 120;
const THREAD_TOP = 80;

function turn(index: number): Turn {
  const mine = index % 2 === 0;
  return {
    id: `t${index}`,
    role: mine ? "user" : "agent",
    text: mine
      ? `Message ${index} — a prompt from me.`
      : `Message ${index} — a reply that runs on for a couple of lines so the ` +
        `transcript has some real height to it and the last row is easy to spot.` +
        // Every third reply carries a fence, so the two copy controls — the
        // block's and the message's — can be seen in the same column.
        (index % 3 === 0 ? "\n\n```ts\nexport const answer = 42;\n```" : ""),
  };
}

/**
 * A reply that is nothing but code, which is the case the message-level Copy
 * has to stay out of: the block's header already carries one, and a second
 * directly beneath it would copy the identical string.
 */
function codeOnlyTurn(index: number): Turn {
  return {
    id: `t${index}`,
    role: "agent",
    text: "```ts\nexport function answer(): number {\n  return 42;\n}\n```",
  };
}

/**
 * The other thing that cannot be summoned on demand: a rejected turn.
 *
 * It is the tail of the thread, which is the only place a retry is offered, and
 * the control has to read as the way out of the failure rather than as more of
 * the error text.
 */
const FAILURE: Turn = {
  id: "fail",
  role: "system",
  text: "Agent exited before finishing: context length exceeded.",
};

export default function ChatThreadHarness() {
  const [count, setCount] = useState(12);
  const [failed, setFailed] = useState(false);
  const [atBottom, setAtBottom] = useState(true);
  const list = useRef<ChatThreadRef>(null);
  const turns = Array.from({ length: count }, (_, i) => turn(i + 1));
  // Second from the end, so it can be compared against a prose reply's action
  // row without scrolling.
  turns.splice(-1, 0, codeOnlyTurn(count + 1));
  if (failed) turns.push(FAILURE);

  return (
    <SafeAreaProvider>
      <StatusBar style="light" />
      <View style={styles.screen}>
        <ChatThread
          ref={list}
          turns={turns}
          threadTop={THREAD_TOP}
          threadBottom={DOCK_HEIGHT + theme.space(2)}
          working={false}
          activity={{ tools: [], speaking: false }}
          indicatorTop={THREAD_TOP}
          indicatorBottom={DOCK_HEIGHT}
          onAtBottomChange={setAtBottom}
          onOpenThought={() => {}}
          onRetry={() => {}}
        />

        {/* Stand-in for the real dock: same job, obvious edge. Anything visible
            below its top line has escaped the reading area. */}
        <View style={[styles.dock, { height: DOCK_HEIGHT }]} pointerEvents="box-none">
          <Text style={styles.dockLabel}>composer ({DOCK_HEIGHT}px) — nothing may sit under here</Text>
          <View style={styles.controls}>
            <Pressable style={styles.button} onPress={() => setCount((c) => c + 1)}>
              <Text style={styles.buttonText}>+1 turn ({count})</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={() => setCount(2)}>
              <Text style={styles.buttonText}>short</Text>
            </Pressable>
            <Pressable style={styles.button} onPress={() => setFailed((f) => !f)}>
              <Text style={styles.buttonText}>{failed ? "clear failure" : "fail last turn"}</Text>
            </Pressable>
            <Text style={styles.buttonText}>{atBottom ? "at bottom" : "scrolled up"}</Text>
          </View>
        </View>
      </View>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.bg },
  dock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    // Deliberately semi-transparent: an opaque dock would hide the very bug
    // this harness exists to show.
    backgroundColor: "rgba(217,119,87,0.35)",
    borderTopWidth: 2,
    borderTopColor: theme.color.accent,
    paddingTop: theme.space(2),
    gap: theme.space(2),
  },
  dockLabel: { color: theme.color.text, fontSize: theme.font.tiny, textAlign: "center" },
  controls: { flexDirection: "row", gap: theme.space(2), justifyContent: "center" },
  button: {
    backgroundColor: theme.color.surfaceRaised,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.space(3),
    paddingVertical: theme.space(2),
  },
  buttonText: { color: theme.color.text, fontSize: theme.font.small },
});
