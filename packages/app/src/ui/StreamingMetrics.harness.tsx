/** Synthetic, dev-only same-device comparison. No user data or network.
 * Raw = prior per-event folding without reveal. Batched = production batcher,
 * fold, identity and transcript rendering. Logs measurements, not guarantees.
 */
import { Profiler, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { theme } from "../theme";
import { ChatThread } from "./ChatThread";
import { createStreamBatch, foldStreamBatch, type StreamChunk } from "../streamBatch";
import { projectDrawerRows } from "../historyMetadata";
import { IDLE_ACTIVITY } from "../activity";
import type { Session, Turn } from "../useDaemon";
import type { LiveStreamIdentity } from "../smoothText";

const noop = () => {};
function initial() {
  const session: Session = { id: "metrics", providerId: "fixture", title: "Synthetic burst", startedAt: 1, turns: [], configOptions: [] };
  return { sessionId: session.id, sessions: [session], turns: [] as Turn[], busy: false, activity: IDLE_ACTIVITY, activeStream: undefined as LiveStreamIdentity | undefined };
}
function Run({ mode, cycle, onDone }: { mode: "raw" | "batched"; cycle: number; onDone: () => void }) {
  const [state, setState] = useState(initial);
  const [projection, setProjection] = useState(() => ({ source: state.sessions, rows: projectDrawerRows([], state.sessions) }));
  if (projection.source !== state.sessions) setProjection({ source: state.sessions, rows: projectDrawerRows(projection.rows, state.sessions) });
  const metrics = useRef({ updates: 0, commits: 0, metadataChanges: 0, firstCommitMs: -1, maxFrameGapMs: 0, frameGapsOver32Ms: 0, actualDurationMs: 0, started: 0 });
  useEffect(() => { metrics.current.metadataChanges++; }, [projection.rows]);
  useEffect(() => {
    let alive = true;
    let seq = 0;
    let previousFrame = performance.now();
    let frame: number;
    let done: ReturnType<typeof setTimeout> | undefined;
    metrics.current.started = performance.now();
    const trackFrame = (now: number) => {
      if (!alive) return;
      const gap = now - previousFrame;
      previousFrame = now;
      metrics.current.maxFrameGapMs = Math.max(metrics.current.maxFrameGapMs, gap);
      if (gap > 32) metrics.current.frameGapsOver32Ms++;
      frame = requestAnimationFrame(trackFrame);
    };
    frame = requestAnimationFrame(trackFrame);
    function commit(events: readonly StreamChunk[]) {
      metrics.current.updates++;
      setState((prev) => {
        const next = foldStreamBatch(prev, events, cycle);
        return mode === "raw" ? { ...next, activeStream: undefined } : next;
      });
    }
    const batch = createStreamBatch(commit, (callback, ms) => setTimeout(callback, ms), clearTimeout);
    const timer = setInterval(() => {
      seq++;
      const text = seq === 1 ? "A repeatable reply. " : `word${seq} `;
      const event: StreamChunk = { id: `metrics:${seq}`, sessionId: "metrics", chunk: { role: "agent", text }, payload: { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } }, now: Date.now() };
      if (mode === "raw") commit([event]); else batch.push(event);
      if (seq === 200) {
        clearInterval(timer);
        batch.boundary();
        setState((prev) => ({ ...prev, busy: false, activeStream: undefined }));
        done = setTimeout(() => {
          if (!alive) return;
          cancelAnimationFrame(frame);
          alive = false;
          console.info("STREAM_METRIC", JSON.stringify({ mode, cycle, ...metrics.current, elapsedMs: performance.now() - metrics.current.started }));
          if (mode === "batched" && cycle === 1) {
            console.info("STREAM_METRICS_FIRST_PAIR");
            done = setTimeout(onDone, 5000);
          } else onDone();
        }, 800);
      }
    }, 10);
    return () => {
      alive = false;
      clearInterval(timer);
      if (done !== undefined) clearTimeout(done);
      cancelAnimationFrame(frame);
      // Batch is already drained at normal completion; flush accepted content
      // on interruption, then cancel every scheduler owned by this run.
      batch.dispose();
    };
  }, [mode, cycle, onDone]);
  return <Profiler id="thread" onRender={(_id, _phase, duration) => {
    const m = metrics.current;
    m.commits++;
    m.actualDurationMs += duration;
    if (state.turns.length && m.firstCommitMs < 0) m.firstCommitMs = performance.now() - m.started;
  }}>
    <ChatThread turns={state.turns} activeStream={state.activeStream} threadTop={120} threadBottom={80} indicatorTop={120} indicatorBottom={80} working={false} activity={state.activity} onOpenThought={noop} onAtBottomChange={noop} onRetry={noop} />
  </Profiler>;
}
export default function StreamingMetricsHarness() {
  const [run, setRun] = useState(0);
  // Stable callback so a render does not restart the owned event clock.
  const done = useRef(() => setRun((n) => n + 1)).current;
  useEffect(() => {
    if (run === 20) console.info("STREAM_METRICS_DONE");
  }, [run]);
  const activeRun = Math.min(run, 19);
  return <SafeAreaProvider><View style={styles.screen}>
    <Text style={styles.label}>Synthetic {run >= 20 ? "complete" : `${run % 2 ? "batched" : "raw"}, cycle ${Math.floor(run / 2) + 1}`}</Text>
    <Run key={activeRun} mode={activeRun % 2 ? "batched" : "raw"} cycle={Math.floor(activeRun / 2) + 1} onDone={done} />
  </View></SafeAreaProvider>;
}
const styles = StyleSheet.create({ screen: { flex: 1, backgroundColor: theme.color.bg }, label: { position: "absolute", top: 70, left: theme.gutter, color: theme.color.text, fontSize: theme.font.small, lineHeight: 18 } });
