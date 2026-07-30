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
import { readChunk } from "./chunks";
import type { PermissionRequest, Session, Turn } from "./useDaemon";

/** True for a user turn rendered before the daemon echoed it back. */
export function isOptimistic(turn: Turn): boolean {
  return turn.id.startsWith("local:");
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
  permission?: PermissionRequest;
}

export function foldSessionEvents<S extends FoldState>(
  prev: S,
  events: readonly ReplayEvent[],
): S {
  if (events.length === 0) return prev;

  const turns = [...prev.turns];
  let busy = prev.busy;
  let permission = prev.permission;
  // One index for the whole batch: mirroring each event into the sessions
  // list with an array copy per event was the other half of the quadratic
  // cost once a provider held hundreds of conversations.
  const byId = new Map(prev.sessions.map((session) => [session.id, session]));

  for (const message of events) {
    const payload = message?.payload;

    if (payload?.kind === "permission_request") {
      const params = payload.params ?? {};
      busy = false;
      permission = {
        requestId: payload.requestId,
        title: params.toolCall?.title ?? "The agent needs your approval",
        options: params.options ?? [
          { optionId: "allow", name: "Allow" },
          { optionId: "reject", name: "Reject" },
        ],
      };
      continue;
    }

    const chunk = readChunk(payload);
    if (!chunk || !chunk.text) continue;

    const last = turns[turns.length - 1];
    // The echo of a prompt this client already rendered: adopt the server id
    // in place rather than showing the message twice.
    const optimistic =
      chunk.role === "user"
        ? turns.findIndex((turn) => isOptimistic(turn) && turn.text === chunk.text)
        : -1;
    if (optimistic >= 0) {
      turns[optimistic] = {
        ...turns[optimistic]!,
        id: `${message.sessionId}:${message.seq}`,
      };
    } else if (last && last.role === chunk.role && chunk.role !== "user") {
      // Coalesce consecutive chunks of the same role into one bubble.
      turns[turns.length - 1] = { ...last, text: last.text + chunk.text };
    } else {
      // `seq` restarts at 0 per session, so it alone would collide across
      // sessions and produce duplicate React keys.
      turns.push({
        id: `${message.sessionId}:${message.seq}`,
        role: chunk.role,
        text: chunk.text,
      });
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
    busy = chunk.role !== "system";
  }

  return {
    ...prev,
    turns,
    sessions: prev.sessions.map((session) => byId.get(session.id) ?? session),
    busy,
    permission,
  };
}
