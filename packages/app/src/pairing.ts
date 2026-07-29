/**
 * Pairing storage on the phone.
 *
 * The token is a bearer secret — anyone holding it can drive every agent on the
 * paired machine — so it lives in the keychain, not in plain app storage.
 * Validation lives in `pairingLink.ts`, which stays pure so it can be tested.
 */
import * as SecureStore from "expo-secure-store";
import { parsePairing, type Pairing } from "./pairingLink";

export { parsePairing, type Pairing, type ParseResult } from "./pairingLink";

const KEY = "pew2.pairing";
const DEVICE_KEY = "pew2.deviceId";

/**
 * A stable id for this install.
 *
 * The relay uses it to tell devices apart, and it must survive restarts: a new
 * id on every launch would make one phone look like an endless stream of
 * different devices.
 */
export async function deviceId(): Promise<string> {
  try {
    const existing = await SecureStore.getItemAsync(DEVICE_KEY);
    if (existing) return existing;
    const minted = `phone-${Math.random().toString(36).slice(2, 10)}`;
    await SecureStore.setItemAsync(DEVICE_KEY, minted);
    return minted;
  } catch {
    // Without storage the id cannot persist; a constant is still better than a
    // connection the relay refuses.
    return "phone";
  }
}

/**
 * Read the stored pairing.
 *
 * Re-validated on the way out rather than trusted: a value written by an older
 * build, or corrupted, must not reach the socket layer where the failure would
 * appear as an unexplained blank screen.
 */
export async function loadPairing(): Promise<Pairing | null> {
  try {
    const stored = await SecureStore.getItemAsync(KEY);
    if (!stored) return null;
    const parsed = parsePairing(stored, await deviceId());
    return parsed.ok ? parsed.pairing : null;
  } catch {
    // A locked or unavailable keychain must show the pairing screen, not crash.
    return null;
  }
}

export async function savePairing(pairing: Pairing): Promise<void> {
  await SecureStore.setItemAsync(KEY, pairing.url);
}

/** Forget the daemon. Used by "Unpair", and after the token is rotated. */
export async function clearPairing(): Promise<void> {
  await SecureStore.deleteItemAsync(KEY);
}
