/**
 * `crypto.getRandomValues`, on a runtime that has no `crypto`.
 *
 * Hermes ships no Web Crypto at all. The encryption layer needs exactly one
 * primitive from the platform — real randomness, for the nonce on every sealed
 * frame — and there is no safe way to produce that in JavaScript. `expo-crypto`
 * bridges to the OS generator (`SecRandomCopyBytes` on iOS, `SecureRandom` on
 * Android), which is the only correct source.
 *
 * Imported before anything else in `index.ts`, because the failure without it is
 * not a build error. The app bundles, launches, and throws the first time it
 * seals a frame — which is the moment someone scans a pairing code, and reads as
 * "the app is broken" rather than "a polyfill is missing".
 *
 * Deliberately not a full Web Crypto shim. Only this one function is needed, and
 * defining a partial `crypto.subtle` would invite code to reach for algorithms
 * that are not actually there.
 */
import { getRandomValues } from "expo-crypto";

const scope = globalThis as { crypto?: Crypto };

// Left alone if the runtime already provides one. On web, and in Node under the
// test runner, the native implementation is already correct and replacing it
// would be strictly worse.
if (!scope.crypto?.getRandomValues) {
  const existing = scope.crypto;
  const shim = {
    getRandomValues,
  } as unknown as Crypto;

  if (existing) {
    // Some runtimes expose a frozen partial `crypto`; adding to it can throw,
    // and a throw here would take the whole app down at startup over a
    // polyfill. Falling back to replacing it keeps that from being fatal.
    try {
      Object.defineProperty(existing, "getRandomValues", {
        value: getRandomValues,
        configurable: true,
        writable: true,
      });
    } catch {
      scope.crypto = shim;
    }
  } else {
    scope.crypto = shim;
  }
}
