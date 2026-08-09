/**
 * The agent list, remembered between launches.
 *
 * Providers are discovered, not configured: the daemon reports which agents are
 * installed on the machine, and until that frame arrives the phone knows of
 * none. Online that gap is a moment. Offline it never closes — so a cold start
 * with no signal had no agent to name, and "send" on a new conversation was
 * refused however well the outbox worked, because there was nothing to address
 * the request to.
 *
 * The last list stands in for that answer. It is a memory of what the machine
 * said, not a claim about what is true now: the live frame replaces it wholesale
 * the moment one arrives, and nothing here is trusted once the daemon speaks.
 *
 * Pure and Expo-free so the shaping and the defensive read are testable;
 * `preferences.ts` owns the storage.
 */
import type { Provider } from "./useDaemon";

/**
 * What is worth keeping.
 *
 * Two fields of the live frame are deliberately not kept, because this is not a
 * copy of it — it is the least that lets someone pick an agent and queue a
 * message to it, held in the keychain, which is meant for small values.
 *
 * `description` because nothing in this app renders it. `unavailableReason`
 * because it is both the bulk of the bytes and the one field that goes stale
 * dishonestly: it explains a state the phone cannot currently observe, and a
 * remembered "not installed" would keep accusing a machine that has since had
 * the agent installed and is merely out of reach.
 */
interface CachedProvider {
  id: string;
  name: string;
  available: boolean;
  color?: string;
}

/**
 * A ceiling on what a cold start can restore.
 *
 * The keychain is not a database, and a machine reporting an implausible number
 * of agents should not turn every launch into a large read. Well past any real
 * install: twelve manifests ship with the app.
 */
export const MAX_CACHED_PROVIDERS = 32;

/**
 * Shape a live provider list for storage.
 *
 * Returns undefined for an empty list, which is the signal not to write. An
 * empty `providers` frame is what the daemon sends while it is still probing,
 * and persisting it would replace a good list with nothing — the next offline
 * launch would then be as stuck as before this existed.
 */
export function toCachedProviders(providers: readonly Provider[]): string | undefined {
  if (providers.length === 0) return undefined;
  const cached: CachedProvider[] = providers.slice(0, MAX_CACHED_PROVIDERS).map((provider) => ({
    id: provider.id,
    name: provider.name,
    available: provider.available,
    ...(provider.color ? { color: provider.color } : {}),
  }));
  return JSON.stringify(cached);
}

/**
 * Read a stored list back, defensively.
 *
 * Everything here was written by some previous build and may be anything at
 * all. A malformed record yields no providers rather than a half-built one: the
 * cost of ignoring it is the behaviour that existed before this cache, while
 * the cost of trusting it is a crash on the launch path.
 */
export function fromCachedProviders(raw: string | null | undefined): Provider[] {
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const providers: Provider[] = [];
  for (const entry of parsed.slice(0, MAX_CACHED_PROVIDERS)) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Partial<CachedProvider>;
    if (typeof record.id !== "string" || !record.id) continue;
    if (typeof record.name !== "string" || !record.name) continue;
    providers.push({
      id: record.id,
      name: record.name,
      // Restored as the empty string the type needs rather than invented text.
      description: "",
      // Anything but an explicit `true` is unavailable. A record from a build
      // that did not write this field must not promise an agent is ready.
      available: record.available === true,
      ...(typeof record.color === "string" ? { color: record.color } : {}),
    });
  }
  return providers;
}
