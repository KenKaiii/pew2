/**
 * Folding a batch of replayed events into one state update.
 *
 * A resumed conversation can replay a thousand events. Applying them one
 * `setState` at a time copies the turns array per event — quadratic work that
 * read on the phone as a multi-second stall after the skeleton. This applies
 * the same rules as the live single-event path, but against working copies,
 * producing one new state (and one render) for the whole batch.
 *
 * Pure and React-free so the fold is directly testable.
 */
import { isEmptyChunk, readChunk, type Chunk } from "./chunks";
import { joinChunks } from "./chunkJoin";
import { readUsage, type ContextUsage } from "./contextUsage";
import { dedupeImages } from "./images";
import type { Session, Turn } from "./useDaemon";

/** True for a user turn rendered before the daemon echoed it back. */
export function isOptimistic(turn: Turn): boolean {
  return turn.id.startsWith("local:");
}

/**
 * Fold a chunk into the turn above it.
 *
 * Shared by the live path and this replay fold so a picture attaches to a
 * bubble the same way in both; the two drifting is how replayed history ends
 * up looking unlike the conversation that produced it.
 */
export function mergeChunk(turn: Turn, chunk: Chunk): Turn {
  const images = chunk.images
    ? dedupeImages([...(turn.images ?? []), ...chunk.images])
    : turn.images;
  // Not a bare concatenation: some agents stream tokens (join them and nothing
  // else) while others send whole messages as they work, which ran together as
  // "Let me check that.Ah, I found it." See `chunkJoin.ts` — the seam decides,
  // so this is right for every agent rather than for a listed few.
  return {
    ...turn,
    text: joinChunks(turn.text, chunk.text),
    ...(images ? { images } : {}),
  };
}

/** A fresh turn for a chunk that starts a new bubble. */
export function turnFromChunk(id: string, chunk: Chunk): Turn {
  return {
    id,
    role: chunk.role,
    text: chunk.text,
    ...(chunk.images ? { images: chunk.images } : {}),
  };
}

export interface ReplayEvent {
  sessionId?: string;
  seq?: number;
  payload?: any;
}

interface FoldState {
  turns: Turn[];
  sessions: Session[];
  busy: boolean;
  permission?: unknown;
  usage?: ContextUsage;
}

export function foldSessionEvents<S extends FoldState>(
  prev: S,
  events: readonly ReplayEvent[],
): S {
  if (events.length === 0) return prev;

  const turns = [...prev.turns];
  // Context usage is the opposite case to `busy` below: it is not a description
  // of work in progress but the session's *current* state, and the last reading
  // in the batch is still true. Skipping it would blank the percentage on every
  // reconnect until the agent happened to send another one — which, mid-
  // conversation, is the moment it is most worth knowing.
  let usage = prev.usage;
  // `busy` and `permission` are deliberately left alone. They describe a turn
  // in progress *now*: a replay is history, so its last chunk is not work
  // being done (a looping "working" indicator on every resumed thread) and a
  // permission request in it was answered long ago (a phantom approve banner).
  // One index for the whole batch: mirroring each event into the sessions
  // list with an array copy per event was the other half of the quadratic
  // cost once a provider held hundreds of conversations.
  const byId = new Map(prev.sessions.map((session) => [session.id, session]));

  for (const message of events) {
    const payload = message?.payload;
    const replayedUsage = readUsage(payload);
    if (replayedUsage) {
      usage = replayedUsage;
      continue;
    }
    const chunk = readChunk(payload);
    if (!chunk || isEmptyChunk(chunk)) continue;

    const last = turns[turns.length - 1];
    // The echo of a prompt this client already rendered: adopt the server id
    // in place rather than showing the message twice. Text is the only handle
    // on that identity, so an image-only chunk never claims to be an echo.
    const optimistic =
      chunk.role === "user" && chunk.text
        ? turns.findIndex((turn) => isOptimistic(turn) && turn.text === chunk.text)
        : -1;
    if (optimistic >= 0) {
      turns[optimistic] = {
        ...turns[optimistic]!,
        id: `${message.sessionId}:${message.seq}`,
      };
    } else if (last && last.role === chunk.role && chunk.role !== "user") {
      // Coalesce consecutive chunks of the same role into one bubble.
      turns[turns.length - 1] = mergeChunk(last, chunk);
    } else {
      // `seq` restarts at 0 per session, so it alone would collide across
      // sessions and produce duplicate React keys.
      turns.push(turnFromChunk(`${message.sessionId}:${message.seq}`, chunk));
    }

    // Mirror into history so the sidebar can reopen this later, and title the
    // session from its first user message.
    const entry = message.sessionId ? byId.get(message.sessionId) : undefined;
    if (entry) {
      byId.set(entry.id, {
        ...entry,
        turns,
        title:
          entry.title === "New conversation" && chunk.role === "user"
            ? chunk.text.trim().slice(0, 60)
            : entry.title,
      });
    }
  }

  return {
    ...prev,
    turns,
    usage,
    sessions: prev.sessions.map((session) => byId.get(session.id) ?? session),
  };
}
