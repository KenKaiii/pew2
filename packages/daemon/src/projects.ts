/**
 * Folding an agent's stored sessions into the projects they were held in.
 *
 * The drawer's history is capped at the newest `SESSION_HISTORY_LIMIT`
 * conversations, which is a recent-work list and emphatically not a list of
 * projects: a fortnight spent in one repo hides every other one the agent
 * knows. So this runs over the *whole* `session/list` answer, before that cap,
 * and is the only complete picture of what a user can pick from.
 *
 * Pure and ACP-free so the grouping rules are directly testable.
 */
import { folderName } from "./workspace.js";

interface SessionLike {
  cwd: string;
  updatedAt?: string;
}

export interface AgentProject {
  path: string;
  name: string;
  sessions: number;
  updatedAt?: string;
}

/**
 * Distinct projects, most recently used first.
 *
 * Ordered by last activity rather than name: the answer to "which project" is
 * nearly always one of the last few, and a phone shows about six rows before
 * scrolling. Undated agents keep their list order, which is already newest
 * first by the time this is called.
 */
export function foldProjects(sessions: readonly SessionLike[]): AgentProject[] {
  const byPath = new Map<string, AgentProject>();

  for (const session of sessions) {
    // Used exactly as reported, never trimmed: this string is the identity a
    // client sends back to list the project, and it is matched against
    // `session.cwd` verbatim. A tidied copy would simply never match.
    const path = session.cwd;
    // A session with no project cannot be filtered to one, and a row reading
    // "/" is not a project anybody chose.
    if (!path?.trim()) continue;
    const name = folderName(path);
    if (!name) continue;

    const existing = byPath.get(path);
    if (!existing) {
      byPath.set(path, { path, name, sessions: 1, updatedAt: session.updatedAt });
      continue;
    }
    existing.sessions += 1;
    // Keep the newest stamp: the list arrives newest first, but an agent that
    // dates nothing leaves gaps, and a later row may be the only dated one.
    if (session.updatedAt && (!existing.updatedAt || session.updatedAt > existing.updatedAt)) {
      existing.updatedAt = session.updatedAt;
    }
  }

  // Undated projects fall to the end — there is nothing to rank them by — but
  // the sort is stable, so among themselves they keep the order the agent
  // listed them in, which is already newest first.
  return [...byPath.values()].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
}

/** The agent's own conversations in one project, newest first. */
export function sessionsInProject<T extends SessionLike>(
  sessions: readonly T[],
  cwd: string,
  limit: number,
): T[] {
  return sessions.filter((session) => session.cwd === cwd).slice(0, limit);
}
