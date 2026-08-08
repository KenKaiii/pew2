/**
 * The single-device rule.
 *
 * This is what makes a leaked pairing link \u2014 a QR caught on video, a URL in a
 * screenshot \u2014 worthless once the real phone has connected. The link itself
 * never expires, so this gate is the only thing standing between a recording and
 * every agent on the machine.
 */
import { test, expect } from "bun:test";
import { decideClaim, isRealClaim, REFUSED_MESSAGE } from "./device-claim.js";

test("an unclaimed pairing is taken by the first device to arrive", () => {
  const decision = decideClaim(undefined, "phone-aaaa");

  expect(decision.ok).toBe(true);
  // The claim is reported back so the caller persists exactly what it admitted,
  // rather than re-deriving it and risking the two disagreeing.
  expect(decision.ok && decision.claim).toBe("phone-aaaa");
});

test("the device that claimed it is admitted again, with nothing to re-persist", () => {
  // Every reconnect for the life of the pairing takes this path: after a
  // reboot, after a network change, after the app is backgrounded for a day.
  const decision = decideClaim("phone-aaaa", "phone-aaaa");

  expect(decision.ok).toBe(true);
  expect(decision.ok && decision.claim).toBeUndefined();
});

test("a second device holding the same link is refused", () => {
  // The whole point. The attacker has the key — they scanned the QR off a
  // recording — and still cannot get in, because the pairing is spoken for.
  const decision = decideClaim("phone-aaaa", "phone-bbbb");

  expect(decision.ok).toBe(false);
  expect(decision.ok === false && decision.message).toBe(REFUSED_MESSAGE);
});

test("the refusal names the way out", () => {
  // A phone that legitimately lost its id — a reinstall clears the keychain —
  // sees the identical refusal to an attacker's. Only the user can tell those
  // apart, so the message has to carry the fix rather than just the verdict.
  expect(REFUSED_MESSAGE).toContain("pew2 pair --rotate");
});

test("a blank device id never claims and never matches", () => {
  // A missing id must not become a wildcard that a stored blank later matches:
  // that would turn the gate off for everyone at once.
  expect(decideClaim(undefined, "").ok).toBe(false);
  expect(decideClaim("", "").ok).toBe(false);
  expect(decideClaim("", "phone-aaaa")).toEqual({ ok: true, claim: "phone-aaaa" });
});

test("ids are matched whole, not by prefix", () => {
  // `phone-aaaa` must not admit `phone-aaaabbbb`. Guessing a prefix is far
  // cheaper than guessing the whole id.
  expect(decideClaim("phone-aaaa", "phone-aaaabbbb").ok).toBe(false);
  expect(decideClaim("phone-aaaabbbb", "phone-aaaa").ok).toBe(false);
});

test("a phone still calling itself 'phone' is admitted, and claims nothing", () => {
  // Apps built before the gate kept the `deviceId=phone` placeholder that
  // `pew2 pair` bakes into printed links. Refusing them would lock out everyone
  // who has not updated yet, on pairings that were never single-device anyway.
  // Recording the claim would be worse: the placeholder would become the owner
  // and refuse that same user the moment they do update.
  expect(decideClaim(undefined, "phone")).toEqual({ ok: true });
  expect(decideClaim("phone-aaaa", "phone")).toEqual({ ok: true });
});

test("a placeholder left on disk is replaced by the first real device", () => {
  // The upgrade path: a pre-gate app claimed `phone`, the user updates, and the
  // new build introduces itself with a real id. That must take the pairing
  // rather than be refused from it.
  expect(decideClaim("phone", "phone-aaaa")).toEqual({ ok: true, claim: "phone-aaaa" });
});

test("a real claim still refuses everyone else", () => {
  // The allowance is only for the placeholder. Once a real device owns the
  // pairing, the gate is exactly as strict as before.
  expect(decideClaim("phone-aaaa", "phone-bbbb").ok).toBe(false);
});

test("only the placeholder counts as unclaimed", () => {
  expect(isRealClaim("phone")).toBe(false);
  expect(isRealClaim(undefined)).toBe(false);
  expect(isRealClaim("")).toBe(false);
  expect(isRealClaim("phone-aaaa")).toBe(true);
});
