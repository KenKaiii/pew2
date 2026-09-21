import type { Session } from "./useDaemon";

export const SESSION_HISTORY_LIMIT = 30;

/** The drawer is a recent-work switcher, not an archive browser. */
export function recentSessionsForProvider<T extends Pick<Session, "providerId">>(
  sessions: T[],
  providerId?: string,
): T[] {
  return sessions
    .filter((session) => !providerId || session.providerId === providerId)
    .slice(0, SESSION_HISTORY_LIMIT);
}
