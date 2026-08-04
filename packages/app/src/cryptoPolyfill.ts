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

/**
 * Install it, wherever it will go.
 *
 * Three attempts, because a runtime may expose `crypto` as a frozen object, as a
 * non-configurable accessor, or not at all, and each rejects a different one of
 * these. Every step is guarded: a throw here happens before the first frame is
 * drawn, so it would be a blank-screen crash with no message anywhere — strictly
 * worse than the clear "No secure random source" the encryption layer already
 * raises at the point of use.
 */
function install(): void {
  // Already present and working. On web, and in Node under the test runner, the
  // native implementation is correct and replacing it would be strictly worse.
  if (scope.crypto?.getRandomValues) return;

  const existing = scope.crypto;
  if (existing) {
    try {
      Object.defineProperty(existing, "getRandomValues", {
        value: getRandomValues,
        configurable: true,
        writable: true,
      });
      return;
    } catch {
      // Frozen. Fall through and try to replace the object itself.
    }
  }

  const shim = { getRandomValues } as unknown as Crypto;
  try {
    scope.crypto = shim;
    // Re-read rather than trust the write: a read-only accessor swallows the
    // assignment silently outside strict mode instead of throwing.
    if (scope.crypto === shim) return;
  } catch {
    // A read-only accessor: assignment throws in strict mode, which every
    // module is. Fall through.
  }

  try {
    Object.defineProperty(globalThis, "crypto", {
      value: shim,
      configurable: true,
      writable: true,
    });
  } catch {
    // Non-configurable too. Nothing further is possible, and failing loudly here
    // would replace a legible error later with an unexplained blank screen now.
  }
}

install();
