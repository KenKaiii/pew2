/**
 * The empty state's rotating line.
 *
 * The failure that matters is not a wrong string, it is a line that changes
 * while someone is reading it: this screen re-renders on every keystroke in the
 * composer, so the pick has to be a pure function of a seed the caller holds
 * steady. The rest is hygiene — no unsubstituted placeholders, no duplicates,
 * nothing long enough to wrap on a phone.
 */
import { expect, test } from "bun:test";
import { GREETINGS, greetingFor, hashSeed } from "./greeting";

test("the same seed always gives the same line", () => {
  // The property the empty state depends on. If this drifted, the greeting
  // would change under the reader on every keystroke in the composer.
  for (const seed of [0, 1, 7, 12345, 999999]) {
    expect(greetingFor("Claude", seed)).toBe(greetingFor("Claude", seed));
  }
});

test("the agent's name is substituted, never left as a placeholder", () => {
  // Every named line reachable, so a missing substitution cannot hide in the
  // one variant nobody happened to draw.
  for (let seed = 0; seed < GREETINGS.named.length; seed++) {
    const line = greetingFor("GG Coder", seed);
    expect(line).not.toContain("{name}");
    expect(line).toContain("GG Coder");
  }
});

test("a missing agent name falls back rather than printing a placeholder", () => {
  // Reachable on a machine with providers configured but none selected yet.
  for (let seed = 0; seed < 20; seed++) {
    const line = greetingFor(undefined, seed);
    expect(line).not.toContain("{name}");
    expect(line).not.toContain("undefined");
    expect(line.length).toBeGreaterThan(0);
  }
});

test("consecutive conversations do not keep drawing the same line", () => {
  // The reason the seed is hashed. Session ids and `new` differ by a character
  // or two, and a weaker mix would map many of them onto one line — a rotation
  // that in practice never rotates.
  const seen = new Set(
    Array.from({ length: 40 }, (_, i) => greetingFor("Codex", hashSeed(`session-${i}`))),
  );
  expect(seen.size).toBeGreaterThanOrEqual(GREETINGS.named.length - 2);
});

test("every line is distinct and short enough not to wrap awkwardly", () => {
  const all = [...GREETINGS.named, ...GREETINGS.unnamed];
  expect(new Set(all).size).toBe(all.length);

  for (const line of all) {
    // The line sits under the orb on a phone. Two rows of text pushes the
    // composer down and turns an invitation into a paragraph. Measured with the
    // longest agent name that ships, since that is the worst case. Asserted as
    // an object so a failure names the offending line rather than just a number.
    const rendered = line.replace("{name}", "GitHub Copilot CLI");
    expect({ line, tooLong: rendered.length > 48 }).toEqual({ line, tooLong: false });
    // Sentence case, ending in a stop or a question mark — these are read as
    // prompts, not labels.
    expect(line).toMatch(/[.?]$/);
  }
});

test("the set is big enough to feel like a rotation", () => {
  // Fewer than ten and the repeat is obvious within a session.
  expect(GREETINGS.named.length).toBeGreaterThanOrEqual(10);
  expect(GREETINGS.named.length + GREETINGS.unnamed.length).toBeLessThanOrEqual(20);
});

test("hashing is stable across runs and spreads adjacent ids apart", () => {
  // Stability matters because the seed is derived from a session id: the same
  // conversation reopened must greet the same way.
  expect(hashSeed("new:claude")).toBe(hashSeed("new:claude"));
  expect(hashSeed("a")).not.toBe(hashSeed("b"));
  expect(hashSeed("")).toBeGreaterThanOrEqual(0);

  // Never negative, or the modulo in `greetingFor` would index off the array.
  for (const value of ["", "x", "session-1", "a".repeat(200)]) {
    expect(hashSeed(value)).toBeGreaterThanOrEqual(0);
  }
});
