/** GG Coder useAgentEvents.ts: first-immediate / subsequent-100ms batching.
 * Unlike GG's concatenated buffer, retain pew2's chunk seams and sequence IDs.
 * See DESIGN.md. Bounds are pew2 safety limits, not upstream tuning.
 */
import type { Chunk } from "./chunks";
import { applyChunk, capTurns } from "./replayFold";
import { foldActivity, type Activity } from "./activity";
import type { Session, Turn } from "./useDaemon";
import type { LiveStreamIdentity } from "./smoothText";

export const STREAM_FLUSH_MS = 100;
export const MAX_BUFFER_EVENTS = 128;
export const MAX_BUFFER_BYTES = 64 * 1024;
export interface StreamChunk {
  sessionId: string;
  id: string;
  chunk: Chunk;
  payload: unknown;
  now: number;
}

// Avoid a native TextEncoder dependency; stop counting once bypass is certain.
function byteSize(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    if (bytes > MAX_BUFFER_BYTES) break;
  }
  return bytes;
}

export function createStreamBatch<Timer>(
  commit: (events: readonly StreamChunk[]) => void,
  schedule: (callback: () => void, ms: number) => Timer,
  cancel: (timer: Timer) => void,
) {
  let queue: StreamChunk[] = [];
  let bytes = 0;
  let owner: string | undefined;
  let role: Chunk["role"] | undefined;
  let timer: Timer | undefined;
  let disposed = false;
  function flush() {
    if (timer !== undefined) cancel(timer);
    timer = undefined;
    const pending = queue;
    queue = [];
    bytes = 0;
    // Snapshot detached before commit: React may replay the updater.
    if (!disposed && pending.length) commit(pending);
  }
  function boundary() {
    flush();
    owner = undefined;
    role = undefined;
  }
  return {
    push(event: StreamChunk) {
      if (disposed) return;
      if (owner !== event.sessionId || role !== event.chunk.role) {
        boundary();
        owner = event.sessionId;
        role = event.chunk.role;
        commit([event]);
        return;
      }
      const size = byteSize(event.chunk.text);
      if (queue.length >= MAX_BUFFER_EVENTS || bytes + size > MAX_BUFFER_BYTES) flush();
      if (size > MAX_BUFFER_BYTES) {
        commit([event]);
        return;
      }
      queue.push(event);
      bytes += size;
      if (timer === undefined) timer = schedule(flush, STREAM_FLUSH_MS);
    },
    flush,
    boundary,
    dispose() {
      boundary(); // accepted events cannot be discarded after cursor advancement
      disposed = true;
    },
  };
}

interface StreamState {
  sessionId?: string;
  turns: Turn[];
  sessions: Session[];
  activity: Activity;
  busy: boolean;
  activeStream?: LiveStreamIdentity;
}

/** One list copy and one session projection per owner batch, against latest state. */
export function foldStreamBatch<S extends StreamState>(state: S, events: readonly StreamChunk[], generation = 0): S {
  const first = events[0];
  if (!first) return state;
  const visible = state.sessionId === first.sessionId;
  const session = state.sessions.find((row) => row.id === first.sessionId);
  if (!visible && !session) return state;
  const turns = [...(visible ? state.turns : session!.turns)];
  let activity = state.activity;
  for (const event of events) {
    if (event.sessionId !== first.sessionId) throw new Error("Mixed stream batch owners");
    applyChunk(turns, event.id, event.chunk);
    if (visible) activity = foldActivity(activity, event.payload, event.now);
  }
  const capped = capTurns(turns);
  const sessions = state.sessions.map((row) => row.id === first.sessionId ? { ...row, turns: capped } : row);
  const last = capped.at(-1);
  const activeStream = last?.role === "agent"
    ? { sessionId: first.sessionId, turnKey: last.key ?? last.id, generation }
    : undefined;
  return visible ? { ...state, turns: capped, sessions, activity, busy: true, activeStream } : { ...state, sessions };
}
