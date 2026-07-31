export const HISTORY_PAGE_SIZE = 15;

/** Keep the newest page mounted; older turns are revealed in fixed-size pages. */
export function visibleHistoryTurns<T>(turns: readonly T[], limit: number): T[] {
  return turns.slice(-Math.max(HISTORY_PAGE_SIZE, limit));
}

export function nextHistoryLimit(current: number, total: number): number {
  return Math.min(total, Math.max(HISTORY_PAGE_SIZE, current) + HISTORY_PAGE_SIZE);
}
