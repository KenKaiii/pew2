/**
 * Folding an agent's own conversation history into the session list.
 *
 * Coding agents persist their sessions on the machine they run on, so the
 * drawer must show work begun at the desk, not just what this phone started.
 * Those entries arrive as stubs: their turns live on the agent's disk and only
 * stream back when one is resumed.
 *
 * Kept pure and react-free so the merge rules are directly testable.
 */
import type { Session } from "./useDaemon";

/** A session entry as the daemon reports it, straight from ACP `session/list`. */
export interface WireAgentSession {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  messageCount?: number;
}

/** Stable local id for a conversation owned by an agent rather than this app. */
export function agentSessionKey(providerId: string, sessionId: string): string {
  return `agent:${providerId}:${sessionId}`;
}

/**
 * Whether a list entry is the agent's own copy rather than a live session.
 *
 * A session started here also carries an `agentSessionId` now — that is what
 * stops the next history probe listing it twice — so the id is what says
 * whether opening it means reloading from the agent's disk or simply showing
 * the transcript already in memory.
 */
export function isAgentSessionStub(id: string): boolean {
  return id.startsWith("agent:");
}

/**
 * Does opening this conversation mean asking the agent to reload it?
 *
 * Two reasons it does. It may be the agent's own copy, whose turns have never
 * been in this app. Or the daemon may no longer hold the session the entry
 * names: ids are assigned per daemon process and die with it, while this list
 * survives restarts and reconnects — prompting one of those answered "Unknown
 * session". Either way the agent's id is what reopens it, so an entry without
 * one is shown from memory and nothing else can be done for it.
 *
 * `liveSessionIds` undefined means the daemon never reported them (an older
 * build): assume live rather than reloading conversations that were fine.
 */
export function needsResume(
  session: Pick<Session, "id" | "agentSessionId">,
  liveSessionIds: Set<string> | undefined,
): boolean {
  if (!session.agentSessionId) return false;
  if (isAgentSessionStub(session.id)) return true;
  return liveSessionIds !== undefined && !liveSessionIds.has(session.id);
}

/** Replace a disk-history stub with its live session without losing its project. */
export function replaceAgentSessionStub(existing: Session[], live: Session): Session[] {
  if (!live.agentSessionId) return [live, ...existing];

  const stub = existing.find((session) => session.agentSessionId === live.agentSessionId);
  return [
    {
      ...live,
      cwd: live.cwd ?? stub?.cwd,
      messageCount: live.messageCount ?? stub?.messageCount,
    },
    ...existing.filter((session) => session.agentSessionId !== live.agentSessionId),
  ];
}

/**
 * Merge an agent's stored conversations into the list already on screen.
 *
 * Sessions this client owns always win: they hold real turns, while an agent
 * entry is only a stub. `canResume` gates the whole thing — listing a thread
 * that cannot be reopened would render a dead row.
 */
export function mergeAgentSessions(
  existing: Session[],
  providerId: string | undefined,
  incoming: WireAgentSession[] | undefined,
  canResume: boolean,
  now: number = Date.now(),
): Session[] {
  if (!providerId || !canResume || !incoming?.length) return existing;

  // Match on the agent's id as well as ours: once a stub is resumed it is
  // tracked under a daemon session id, and must not reappear as a duplicate.
  const seen = new Set(existing.map((s) => s.agentSessionId ?? s.id));

  const discovered: Session[] = incoming
    .filter((s) => s.sessionId && !seen.has(s.sessionId))
    .map((s) => ({
      id: agentSessionKey(providerId, s.sessionId),
      providerId,
      title: s.title?.trim() || "Untitled conversation",
      // Undated sessions sort as "just now" rather than to 1970, which would
      // bury a real conversation at the bottom of the list.
      startedAt: parseUpdatedAt(s.updatedAt) ?? now,
      turns: [],
      messageCount: s.messageCount,
      configOptions: [],
      agentSessionId: s.sessionId,
      cwd: s.cwd,
    }));

  if (discovered.length === 0) return existing;
  return [...existing, ...discovered].sort((a, b) => b.startedAt - a.startedAt);
}

/** ISO 8601 -> epoch ms, ignoring anything unparseable. */
function parseUpdatedAt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}
