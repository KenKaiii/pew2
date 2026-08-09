/**
 * The drawer entry for a conversation that has been asked for but does not
 * exist yet.
 *
 * `session.start` is a request, not a creation: the daemon has to spawn the
 * agent and complete an ACP handshake before it can answer with an id, which
 * takes seconds. Until this module existed the app posted that request and
 * added nothing to the list, on the reasoning that `session.started` would
 * create the entry when it landed. That holds only while the frame lands. Send
 * a prompt that starts a conversation, switch to another one while the agent
 * boots, and the new conversation was in no list at all — still running on the
 * desktop, unreachable from the phone, and only a relaunch brought it back.
 *
 * So the entry is created by the request instead, and the answer adopts it. A
 * conversation the user started is visible from the moment they start it, and
 * the failure modes degrade in the right direction: a lost answer leaves a row
 * that can be cleaned up, rather than work with nowhere to appear.
 *
 * Pure and React-free so the adoption rules are directly testable.
 */
import type { Session } from "./useDaemon";

/**
 * Local id for a conversation the daemon has not named yet.
 *
 * Prefixed rather than random so every other part of the app can recognise one
 * without being told. `isFixtureSession` and `isAgentSessionStub` already work
 * this way, and the prefix is what keeps a prompt, a cancel or a config change
 * from being addressed to an id the daemon has never heard of.
 */
export function pendingSessionKey(requestId: string): string {
  return `pending:${requestId}`;
}

/** Whether a list entry is a request still waiting for its `session.started`. */
export function isPendingSession(id: string): boolean {
  return id.startsWith("pending:");
}

/**
 * The drawer entry to show while the agent boots.
 *
 * Marked working from the start, because it is: the clock began when the
 * prompt left the phone, and spawning the agent is part of the wait the user
 * is being shown. A conversation started with no prompt is not working, and
 * says so.
 */
export function pendingSession(
  requestId: string,
  providerId: string,
  firstPrompt: string | undefined,
  now: number,
): Session {
  return {
    id: pendingSessionKey(requestId),
    providerId,
    // The prompt is the title everywhere else in this app; using it here too
    // means adoption does not visibly rename the row the user just created.
    title: firstPrompt?.trim().slice(0, 60) || "New conversation",
    startedAt: now,
    turns: [],
    configOptions: [],
    busy: firstPrompt !== undefined,
  };
}

/**
 * Swap a pending entry for the live session the daemon answered with.
 *
 * Position is preserved rather than prepending, so the row does not jump out
 * from under a thumb already reaching for it. Everything the pending entry
 * accumulated while it waited — the optimistic first turn above all — is kept:
 * it belongs to this conversation, which was started to carry it.
 *
 * Returns undefined when no pending entry matches, which is the ordinary case
 * for a session another device started. The caller then falls back to the
 * stub-replacing merge, and adopting on a mismatch here is exactly how one
 * phone would steal the row of a conversation begun on another.
 */
export function adoptPendingSession(
  existing: readonly Session[],
  requestId: string | undefined,
  live: Session,
): Session[] | undefined {
  if (!requestId) return undefined;
  const key = pendingSessionKey(requestId);
  const at = existing.findIndex((session) => session.id === key);
  if (at < 0) return undefined;

  const waiting = existing[at]!;
  const adopted: Session = {
    ...live,
    // The pending entry's turns, not the live one's: `session.started` carries
    // no transcript, and the optimistic prompt rendered under it is the only
    // copy that exists until the agent replies.
    turns: waiting.turns.length > 0 ? waiting.turns : live.turns,
    title: live.title === "New conversation" ? waiting.title : live.title,
    startedAt: waiting.startedAt,
    busy: live.busy ?? waiting.busy,
  };
  const next = [...existing];
  next[at] = adopted;
  return next;
}

/**
 * Drop requests that can no longer be answered.
 *
 * Called when the socket comes back up. A `session.start` written to a socket
 * that then died was either never received or was answered into the void, and
 * either way this client will not be told: `session.started` is broadcast once,
 * at the moment it happens, and the relay stores nothing. Leaving the row would
 * put a conversation in the drawer that opens onto nothing and never stops
 * pulsing — a worse outcome than the invisible session this whole module
 * exists to prevent, because it cannot be dismissed.
 *
 * A session that really was created still comes back: the daemon lists it in
 * `activeSessions`, and its agent-side copy is discovered by the next history
 * probe. That path is slower, and it is the honest one.
 */
export function dropPendingSessions(existing: readonly Session[]): Session[] {
  return existing.some((session) => isPendingSession(session.id))
    ? existing.filter((session) => !isPendingSession(session.id))
    : (existing as Session[]);
}
