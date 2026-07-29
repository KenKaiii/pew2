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
}

/** Stable local id for a conversation owned by an agent rather than this app. */
export function agentSessionKey(providerId: string, sessionId: string): string {
  return `agent:${providerId}:${sessionId}`;
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
