/**
 * Dev-only harness for what happens when the composer grows a line.
 *
 * Not a component in isolation: this reproduces the chain the real screen sets
 * up around the composer, because that chain is where the cost is. A wrapped
 * line changes the dock's height, the dock reports it through `onLayout`, and
 * everything downstream of that measurement — the thread's bottom inset, its
 * header and footer spacers, the follow-scroll that keeps the last message
 * visible — reacts to it. None of that is visible when the composer is mounted
 * alone, which is exactly why three separate fixes were aimed at the composer
 * itself while the stall sat above it.
 *
 * So the dock and the transcript are wired here the way `App.tsx` wires them,
 * and typing into it exercises the real path. The counters are the point: they
 * show what a single wrapped line costs in renders, at the moment the box is
 * supposed to be following the caret.
 *
 * `EXPO_PUBLIC_HARNESS=Dock bun run harness`
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider, useSafeAreaInsets } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import * as SplashScreen from "expo-splash-screen";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { theme } from "../theme";
import { dockHeightFor, recordDockHeight, type DockHeights } from "../dockHeight";
import { IDLE_ACTIVITY } from "../activity";
import { ChatThread, type ChatThreadRef } from "./ChatThread";
import { ComposerDock, type ComposerDockHandle } from "./ComposerDock";
import type { Turn } from "../useDaemon";

/** Enough rows that the list is really scrolling, as a used conversation is. */
const TURNS: Turn[] = Array.from({ length: 24 }, (_, index) => ({
  id: `t${index}`,
  role: index % 2 === 0 ? "user" : "agent",
  text:
    index % 2 === 0
      ? `Message ${index} — a prompt from me.`
      : `Message ${index} — a reply long enough to wrap onto a second line so the ` +
        `transcript has real height and the last row is easy to watch.`,
}));

/**
 * Typing steps before the harness stops.
 *
 * Enough to carry the composer from one line to its eight-line ceiling, which
 * is the whole of the growth worth measuring.
 */
const STEPS = 14;

/**
 * Counts renders of the component it is called in.
 *
 * A ref rather than state, so counting never causes the thing it is counting.
 */
function useRenderCount(): number {
  const count = useRef(0);
  count.current += 1;
  return count.current;
}

function Screen() {
  const insets = useSafeAreaInsets();
  const composer = useRef<ComposerDockHandle>(null);
  const list = useRef<ChatThreadRef>(null);
  const [dockHeights, setDockHeights] = useState<DockHeights>({ typing: 0, resting: 0 });
  const [typing, setTyping] = useState(false);
  const renders = useRenderCount();

  // Exactly the arithmetic in `App.tsx`, so the harness measures that screen's
  // behaviour rather than a simplified stand-in of it.
  const restingDockHeight =
    theme.size.composerCollapsed + theme.space(2) + (insets.bottom + theme.space(2));
  const dockHeight = dockHeightFor(dockHeights, typing, restingDockHeight);
  const threadBottom = dockHeight + theme.space(2);

  const send = useCallback(() => true, []);
  const noop = useCallback(() => {}, []);

  // Renders counted at each new dock height, which is what a wrapped line
  // costs. Kept in a ref and sampled, rather than pushed into state, because
  // storing a measurement in state is itself a render and would measure this
  // harness instead of the thing under test.
  const log = useRef<string[]>([]);
  const lastHeight = useRef(0);
  const rendersAtLastWrap = useRef(0);
  if (dockHeight !== lastHeight.current) {
    if (lastHeight.current !== 0) {
      log.current = [
        ...log.current.slice(-5),
        `+${Math.round(dockHeight - lastHeight.current)}px → ${renders - rendersAtLastWrap.current} renders`,
      ];
    }
    lastHeight.current = dockHeight;
    rendersAtLastWrap.current = renders;
  }

  // Types into itself, because the simulator has neither a tap API nor — absent
  // an Accessibility grant — a way to deliver keystrokes. A harness that could
  // only be driven by hand would be no better than the phone it replaces, so it
  // drives itself and the numbers can be read straight off a screenshot.
  const [step, setStep] = useState(0);
  useEffect(() => {
    composer.current?.focus();
    const timer = setInterval(() => {
      // Stops at the ceiling. Past that the composer cannot grow, so every
      // further step measures nothing while the draft grows without bound — and
      // a harness left open would sit there allocating for as long as it is on
      // screen, which is exactly the kind of drift that makes a measurement
      // untrustworthy the second time someone runs it.
      setStep((n) => (n >= STEPS ? n : n + 1));
    }, 500);
    return () => clearInterval(timer);
  }, []);
  useEffect(() => {
    if (step === 0) return;
    // A few words at a time, as someone typing would, so growth arrives at the
    // wrap boundary rather than in one jump.
    composer.current?.setDraft(Array.from({ length: step * 3 }, () => "word").join(" "));
  }, [step]);

  return (
    <View style={styles.screen}>
      <StatusBar style="light" />
      <ChatThread
        ref={list}
        turns={TURNS}
        threadTop={insets.top + theme.space(12)}
        threadBottom={threadBottom}
        working={false}
        activity={IDLE_ACTIVITY}
        indicatorTop={insets.top}
        indicatorBottom={dockHeight}
        onAtBottomChange={noop}
        onOpenThought={noop}
        onRetry={noop}
      />
      {/* What a wrapped line actually costs, where it can be read while typing.
          The root count is the one that matters: it should not move at all as
          the box grows, and every increment of it is a full re-render landing
          on the JS thread in the same frame as the growth animation. */}
      <View style={[styles.readout, { top: insets.top + theme.space(2) }]}>
        <Text style={styles.readoutText}>root renders: {renders}</Text>
        <Text style={styles.readoutText}>dock height: {Math.round(dockHeight)}</Text>
        {log.current.map((line) => (
          <Text key={line} style={styles.readoutText}>
            {line}
          </Text>
        ))}
      </View>
      <ComposerDock
        ref={composer}
        style={[styles.dock, { paddingBottom: insets.bottom + theme.space(2) }]}
        onHeightSettled={(height) => {
          setDockHeights((prev) => recordDockHeight(prev, typing, height));
        }}
        typing={typing}
        showCommands={false}
        onCommands={noop}
        onSend={send}
        editable
        placeholder="Type here and watch the counter"
        attachments={[]}
        onAttach={noop}
        onRemoveAttachment={noop}
        dictation={{ available: false, listening: false, toggle: noop, cancel: noop }}
      />
      {/* Stands in for the keyboard listener the real screen runs. Tapping it
          is how the resting and typing dock heights are both exercised without
          needing a hardware keyboard attached to the simulator. */}
      <Text style={[styles.toggle, { bottom: insets.bottom }]} onPress={() => setTyping((t) => !t)}>
        typing: {String(typing)}
      </Text>
    </View>
  );
}

export default function DockHarness() {
  // `index.ts` holds the native splash open and documents that `App` performs
  // the matching hide. A harness stands in for `App`, so it inherits that
  // obligation — without this the simulator sits on the splash forever, looking
  // exactly like a harness that failed to render, which is the first thing this
  // harness itself did.
  useEffect(() => {
    SplashScreen.hideAsync().catch(() => {
      // Already hidden, or no splash on this platform.
    });
  }, []);

  return (
    <KeyboardProvider>
      <SafeAreaProvider>
        <Screen />
      </SafeAreaProvider>
    </KeyboardProvider>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: theme.color.bg },
  dock: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
    paddingHorizontal: theme.gutter,
    paddingTop: theme.space(2),
  },
  readout: {
    position: "absolute",
    left: theme.gutter,
    zIndex: 10,
    backgroundColor: "#000000cc",
    padding: theme.space(1),
    borderRadius: theme.space(1),
  },
  readoutText: { color: "#4ade80", fontSize: 12, fontVariant: ["tabular-nums"] },
  toggle: { position: "absolute", right: theme.gutter, color: theme.color.textDim, fontSize: 11 },
});
