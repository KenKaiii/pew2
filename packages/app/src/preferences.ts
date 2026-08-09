/**
 * Small per-install preferences that must survive the app being closed.
 *
 * SecureStore is the only persistent store this app already depends on, so it
 * carries these too; nothing here is a secret. Expo-bound on purpose — the
 * decision rules live in `lastProvider.ts` and `providerCache.ts`, which stay
 * testable.
 */
import * as SecureStore from "expo-secure-store";
import { fromCachedProviders, toCachedProviders } from "./providerCache";
import type { Provider } from "./useDaemon";

const LAST_PROVIDER_KEY = "pew2.lastProviderId";
const PROVIDERS_KEY = "pew2.providers";

/** The agent last targeted on this device, or null if never chosen. */
export async function loadLastProvider(): Promise<string | null> {
  try {
    return await SecureStore.getItemAsync(LAST_PROVIDER_KEY);
  } catch {
    // A locked or unavailable keychain just means "no preference"; the caller
    // falls back to the first available agent rather than failing to launch.
    return null;
  }
}

export async function saveLastProvider(providerId: string): Promise<void> {
  try {
    await SecureStore.setItemAsync(LAST_PROVIDER_KEY, providerId);
  } catch {
    // Losing a preference is not worth surfacing, let alone crashing over.
  }
}

/**
 * The agents this machine reported last time, for a launch with no signal.
 *
 * Empty whenever anything is wrong — no store, no record, junk from an older
 * build — which is exactly the state the app had before this cache existed.
 * See `providerCache.ts` for why it is worth having at all.
 */
export async function loadCachedProviders(): Promise<Provider[]> {
  try {
    return fromCachedProviders(await SecureStore.getItemAsync(PROVIDERS_KEY));
  } catch {
    return [];
  }
}

export async function saveCachedProviders(providers: readonly Provider[]): Promise<void> {
  try {
    const payload = toCachedProviders(providers);
    // An empty list is the daemon still probing, not an answer. Writing it would
    // erase a good list and leave the next offline launch as stuck as before.
    if (!payload) return;
    await SecureStore.setItemAsync(PROVIDERS_KEY, payload);
  } catch {
    // Same trade as above: a cache that fails to write costs one offline launch,
    // and is never worth taking the app down for.
  }
}

/**
 * Forget the remembered agents.
 *
 * Called when a pairing is dropped: the list describes one specific machine, and
 * carrying it to the next one would offer agents that computer may not have.
 */
export async function clearCachedProviders(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(PROVIDERS_KEY);
  } catch {
    // Nothing to do — the next machine to answer overwrites it anyway.
  }
}
