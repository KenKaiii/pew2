import { expect, test } from "bun:test";
import { MIN_GAP_MS, shouldFire } from "./hapticsPolicy";

test("the first haptic always plays", () => {
  expect(shouldFire(0, undefined)).toBe(true);
  expect(shouldFire(1_000_000, undefined)).toBe(true);
});

test("suppresses a pulse that would land on top of the previous one", () => {
  // A failed turn emits an error and goes idle milliseconds apart. Both firing
  // is felt as one mushy buzz rather than a clear signal.
  expect(shouldFire(1000 + MIN_GAP_MS - 1, 1000)).toBe(false);
  expect(shouldFire(1000, 1000)).toBe(false);
});

test("allows a pulse once the motor has settled", () => {
  expect(shouldFire(1000 + MIN_GAP_MS, 1000)).toBe(true);
  expect(shouldFire(5000, 1000)).toBe(true);
});

test("a backwards clock jump does not mute feedback", () => {
  // NTP correction or a timezone change would otherwise leave the app silent
  // until real time caught back up.
  expect(shouldFire(500, 1000)).toBe(true);
});
