/**
 * Ordering the drawer's app chips by last use.
 *
 * The chip row scrolls horizontally, so the app you reach for daily should not
 * be off-screen behind apps you tried once. "Used" means conversation activity:
 * a provider's recency is its newest session, and sessions from an agent's own
 * history carry the agent's `updatedAt`, so desk work counts the same as phone
 * work.
 *
 * Pure and React-free so the ordering rules are directly testable.
 */

interface ProviderLike {
  id: string;
  available: boolean;
}

interface SessionLike {
  providerId: string;
  startedAt: number;
}

/**
 * Available and used first, most recent activity leading; available but never
 * used next, in their original order; unavailable last regardless of history —
 * a chip you cannot open is never worth prime positions.
 */
export function orderProvidersByRecency<P extends ProviderLike>(
  providers: readonly P[],
  sessions: readonly SessionLike[],
): P[] {
  const lastUsed = new Map<string, number>();
  for (const session of sessions) {
    lastUsed.set(
      session.providerId,
      Math.max(lastUsed.get(session.providerId) ?? 0, session.startedAt),
    );
  }

  const rank = (provider: P): number => {
    if (!provider.available) return 2;
    return lastUsed.has(provider.id) ? 0 : 1;
  };

  // `sort` is stable, so providers within a group keep their manifest order.
  return [...providers].sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    if (ra === 0) return (lastUsed.get(b.id) ?? 0) - (lastUsed.get(a.id) ?? 0);
    return 0;
  });
}
