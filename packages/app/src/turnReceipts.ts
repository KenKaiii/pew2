/**
 * Where a finished turn's summary lives.
 *
 * "Answered in 3s" is produced when a turn ends and used to be held only in the
 * screen's own state. That made it a property of what you were looking at
 * rather than of the turn: it appeared as the reply landed, and leaving the
 * conversation and coming back erased it. The line was visible exactly once,
 * while you watched it happen.
 *
 * These two functions are the whole of the fix — one stores the summary on the
 * conversation, the other decides what to show when a conversation is opened —
 * and they are here rather than inline in the reducer so both are testable
 * without a socket.
 */
import type { TurnReceipt } from "./activity";
import type { Session } from "./useDaemon";

/**
 * Attach a finished turn's summary to the conversation that produced it.
 *
 * The summary is undefined for a conversation that finished in the background:
 * its tool calls were never rendered, so there is no live activity to measure
 * and inventing one would be a guess. In that case whatever the session already
 * had is kept, which is the last turn this device actually watched.
 */
export function recordReceipt(
  sessions: readonly Session[],
  sessionId: string | undefined,
  receipt: TurnReceipt | undefined,
): Session[] {
  if (!sessionId) return sessions as Session[];
  const at = sessions.findIndex((session) => session.id === sessionId);
  if (at < 0) return sessions as Session[];
  const next = [...sessions];
  next[at] = { ...next[at]!, receipt: receipt ?? next[at]!.receipt };
  return next;
}

/**
 * The summary to show when a conversation is opened.
 *
 * Nothing while the agent is still working: that turn has not finished, so
 * nothing about it has been measured, and showing the previous turn's receipt
 * under a running one would date-stamp the wrong reply.
 */
export function receiptOnOpen(session: Pick<Session, "busy" | "receipt">): TurnReceipt | undefined {
  return session.busy === true ? undefined : session.receipt;
}
