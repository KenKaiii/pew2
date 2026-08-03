/**
 * Small per-install preferences that must survive the app being closed.
 *
 * SecureStore is the only persistent store this app already depends on, so it
 * carries these too; nothing here is a secret. Expo-bound on purpose — the
 * decision rules live in `lastProvider.ts`, which stays testable.
 */
import * as SecureStore from "expo-secure-store";

const LAST_PROVIDER_KEY = "pew2.lastProviderId";

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
