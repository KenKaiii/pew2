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
import { foldActivity, IDLE_ACTIVITY, type Activity } from "./activity";
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
 * The most turns one conversation keeps in memory.
 *
 * Every other store in the system is bounded — the daemon's session log at 10k,
 * its transcript cache at 400 — and the phone, which has the least memory of
 * anything involved, was the one place that grew without limit. A long agent run
 * emits thousands of chunks, and they are held twice: once as the open
 * transcript and once inside the drawer entry it mirrors into.
 *
 * Matched to the transcript cache on purpose. That is what a reopened
 * conversation paints from, so a session kept in memory and the same session
 * reopened show the same amount of history rather than differing by how long
 * the app happened to be running.
 *
 * It now bounds every conversation rather than only the open one, since each
 * carries its own transcript — which is the same ceiling per session, not a new
 * one, because the drawer entry was always being filled in parallel.
 */
const MAX_TURNS = 400;

/**
 * Keep the newest turns, dropping from the front.
 *
 * The front is what a scrolled-to-bottom chat view is least likely to be
 * looking at, and it is also what the daemon has already written to its own
 * transcript — so nothing is lost that reopening the conversation cannot show.
 */
export function capTurns(turns: Turn[]): Turn[] {
  return turns.length > MAX_TURNS ? turns.slice(turns.length - MAX_TURNS) : turns;
}

/**
 * Apply one chunk to a working copy of a transcript.
 *
 * The single definition of how a streamed chunk becomes a bubble, mutating the
 * array it is handed rather than copying per event — a batch of a thousand does
 * one allocation, not a thousand. Three callers share it: the live path, the
 * replay fold below, and background sessions. They were separate copies of the
 * same twenty lines, and the comment on `mergeChunk` already names the cost of
 * letting them drift: replayed history stops looking like the conversation that
 * produced it. A background transcript drifting would be worse still, because
 * the difference only shows up once the user switches back.
 *
 * @param key Turn id, unique across sessions. `seq` restarts at 0 for each one.
 */
export function applyChunk(turns: Turn[], key: string, chunk: Chunk): void {
  const last = turns[turns.length - 1];
  // The echo of a prompt this client already rendered: adopt the server id in
  // place rather than showing the message twice. Text is the only handle on
  // that identity, so an image-only chunk never claims to be an echo of one.
  const optimistic =
    chunk.role === "user" && chunk.text
      ? turns.findIndex((turn) => isOptimistic(turn) && turn.text === chunk.text)
      : -1;
  if (optimistic >= 0) {
    turns[optimistic] = { ...turns[optimistic]!, id: key };
  } else if (last && last.role === chunk.role && chunk.role !== "user") {
    // Coalesce consecutive chunks of the same role into one bubble.
    turns[turns.length - 1] = mergeChunk(last, chunk);
  } else {
    turns.push(turnFromChunk(key, chunk));
  }
}

/** A session's title once its first user message has arrived. */
function titledBy(session: Session, chunk: Chunk): string {
  return session.title === "New conversation" && chunk.role === "user"
    ? chunk.text.trim().slice(0, 60)
    : session.title;
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

interface CatchUpState extends FoldState {
  activity: Activity;
  loadingSession: boolean;
}

/**
 * Fold a reconnect catch-up batch — events from a turn that is still running.
 *
 * The mirror image of `foldSessionEvents`, and the distinction matters more
 * than it looks. Both arrive as a `session.replay` frame, but a resume replay
 * is a transcript of work that finished long ago (so it must not light up the
 * activity line, and its permission requests were answered by someone else),
 * while a catch-up is the last few seconds of work happening *now*: the socket
 * was simply down while it happened. Folding a catch-up as history is what left
 * a phone that blinked mid-turn showing nothing at all until the agent happened
 * to start its next tool — twenty seconds of silence, then a shell command out
 * of nowhere.
 *
 * `working` comes from the daemon rather than being inferred from the events:
 * `session.idle` is broadcast and never logged, so a turn that ended while this
 * client was away replays nothing that says so.
 */
export function foldCatchUp<S extends CatchUpState>(
  prev: S,
  sessionId: string | undefined,
  events: readonly ReplayEvent[],
  working: boolean,
  now: number,
): S {
  const folded = foldSessionEvents(prev, events);
  let activity = prev.activity;
  for (const event of events) activity = foldActivity(activity, event.payload, now);
  return {
    ...folded,
    loadingSession: false,
    busy: working,
    // A finished turn has nothing left to name. Its receipt is deliberately not
    // reconstructed here: this device never timed the turn, and "Answered in 0s"
    // is a worse answer than no receipt at all.
    activity: working ? activity : IDLE_ACTIVITY,
    sessions: folded.sessions.map((session) =>
      session.id === sessionId && session.busy !== working
        ? { ...session, busy: working }
        : session,
    ),
  };
}

/**
 * Fold events into a conversation the user is not currently reading.
 *
 * Every session carries its own transcript, so a reply that lands while the
 * user is elsewhere is written into the conversation it belongs to and is there
 * when they come back. The alternative, and what this replaces, was to drop the
 * event: the daemon broadcasts every session's output to every client, and
 * anything not matching the visible session was discarded on arrival. Switching
 * away while an agent worked therefore meant returning to your own prompt and
 * nothing under it, with the answer already delivered and thrown away.
 *
 * Deliberately narrow: turns, title and `busy`, and nothing else. `activity`,
 * `receipt`, `permission` and `usage` all describe the transcript on screen —
 * a background session's tool calls were never rendered, its context meter
 * belongs to another project, and its permission prompt would appear over a
 * conversation that did not ask for it.
 *
 * Returns `prev` unchanged when there is nothing to apply, so a session the
 * drawer has not heard of and an event carrying no chunk both cost one lookup
 * and no render.
 */
export function foldBackgroundEvent<S extends { sessions: Session[] }>(
  prev: S,
  sessionId: string | undefined,
  key: string,
  payload: unknown,
): S {
  if (!sessionId) return prev;
  const chunk = readChunk(payload);
  if (!chunk || isEmptyChunk(chunk)) return prev;
  const at = prev.sessions.findIndex((session) => session.id === sessionId);
  if (at < 0) return prev;

  const session = prev.sessions[at]!;
  const turns = [...session.turns];
  applyChunk(turns, key, chunk);
  const sessions = [...prev.sessions];
  sessions[at] = {
    ...session,
    turns: capTurns(turns),
    title: titledBy(session, chunk),
    // A system chunk is a failure notice, not work in progress — the same rule
    // the visible path applies, so the drawer dot and the spinner agree.
    busy: chunk.role !== "system",
  };
  return { ...prev, sessions };
}

/**
 * Apply a catch-up batch for a conversation that is not the one on screen.
 *
 * The same events `foldCatchUp` applies to the visible transcript, applied to
 * the one they belong to. Runs on reconnect, when the missed events of every
 * session arrive at once.
 *
 * `working` is carried separately because it cannot be inferred from the
 * events: `session.idle` is broadcast and never logged, so a turn that ended
 * while this client was away replays nothing that says so. It also has to be
 * applied even when the batch is empty — reconnecting clears `busy` on every
 * row, so without this a conversation that really is still working came back
 * from a drop looking finished, and stayed that way until it happened to
 * produce a notification.
 */
export function foldBackgroundCatchUp<S extends { sessions: Session[] }>(
  prev: S,
  sessionId: string | undefined,
  events: readonly ReplayEvent[],
  working: boolean,
): S {
  if (!sessionId) return prev;
  let next = prev;
  for (const event of events) {
    next = foldBackgroundEvent(next, sessionId, `${sessionId}:${event.seq}`, event.payload);
  }
  const at = next.sessions.findIndex((session) => session.id === sessionId);
  if (at < 0 || next.sessions[at]!.busy === working) return next;
  const sessions = [...next.sessions];
  sessions[at] = { ...sessions[at]!, busy: working };
  return { ...next, sessions };
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

    applyChunk(turns, `${message.sessionId}:${message.seq}`, chunk);

    // Mirror into history so the sidebar can reopen this later, and title the
    // session from its first user message.
    const entry = message.sessionId ? byId.get(message.sessionId) : undefined;
    if (entry) byId.set(entry.id, { ...entry, turns, title: titledBy(entry, chunk) });
  }

  return {
    ...prev,
    turns,
    usage,
    sessions: prev.sessions.map((session) => byId.get(session.id) ?? session),
  };
}
