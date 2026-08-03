/**
 * Which agent a fresh launch targets.
 *
 * The app is a remote control for whatever agent the user actually works with,
 * so re-opening it must land on the one they used last — not on whichever
 * manifest happens to sort first (Claude Code). The remembered id is stored by
 * `preferences.ts`; this half stays pure so the fallback rules are testable.
 */

interface ProviderLike {
  id: string;
  available: boolean;
}

/**
 * The remembered agent when it is still installed and available; otherwise the
 * first available one, which is the only sensible thing to point a composer at.
 *
 * An unavailable remembered agent is deliberately skipped rather than shown:
 * the machine may have changed, and a chip that cannot open a session is worse
 * than a different agent that can.
 */
export function defaultProviderId<P extends ProviderLike>(
  providers: readonly P[],
  remembered: string | undefined,
): string | undefined {
  const last = remembered
    ? providers.find((p) => p.id === remembered && p.available)
    : undefined;
  return (last ?? providers.find((p) => p.available))?.id;
}
