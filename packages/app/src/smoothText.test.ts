import { expect, test } from "bun:test";
import { advance, resetReveal, updateReveal, tickReveal, revealSettled, safePrefixLength, streamIdentityKey, SETTLE_MS } from "./smoothText";

test("initial history is fully visible and settled", () => {
  const state = resetReveal("a", "history", 100);
  expect(state.committed).toBe(7);
  expect(revealSettled(state, 100)).toBe(true);
});
test("GG pacing adapts to backlog without overshoot or backwards time", () => {
  expect(advance(0, 10, 5)).toBe(1);
  expect(advance(0, 1000, 25)).toBe(100);
  expect(advance(10, 10, 99)).toBe(10);
  expect(advance(0, 10, -3)).toBe(0);
});
test("burst growth is paced, throttles commits and always commits final tail", () => {
  let state = updateReveal(resetReveal("a", "start", 0), "a", "start" + "x".repeat(100), 20, true);
  state = tickReveal(state, 30);
  expect(state.committed).toBe(5);
  state = tickReveal(state, 53);
  expect(state.committed).toBeGreaterThan(5);
  expect(state.committed).toBeLessThan(105);
  state = tickReveal(state, 600);
  expect(state.committed).toBe(105);
  expect(revealSettled(state, 20 + SETTLE_MS)).toBe(true);
});
test("long pause does not bank reveal time for the next burst", () => {
  const state = updateReveal(resetReveal("a", "old", 0), "a", "old new", 10000, true);
  expect(tickReveal(state, 10000).committed).toBe(3);
});
test.each(["replay", "navigation", "recycled-cell"])("%s identity resets even when the replacement shares a prefix", (reason) => {
  const state = updateReveal(resetReveal("a", "shared", 0), reason, "shared but different", 30, true);
  expect(state.committed).toBe(state.target.length);
  expect(revealSettled(state, 30)).toBe(true);
});
test("non-prefix replacement resets immediately", () => {
  const state = updateReveal(resetReveal("a", "old", 0), "a", "new", 10, true);
  expect(state.committed).toBe(3);
  expect(state.target).toBe("new");
});
test.each(["completion", "reduced-motion", "background"])("%s snaps even before any frame runs", () => {
  const queued = updateReveal(resetReveal("a", "", 0), "a", "complete tail", 1, true);
  const done = updateReveal(queued, "a", "complete tail", 2, false);
  expect(done.committed).toBe(13);
});
test.each(["a👩🏽‍💻b", "a🇯🇵b", "aक्षिb", "ae\u0301b", "a世界b", "a\r\nb"])("cuts only whole graphemes: %s", (text) => {
  const ends = new Set([0, ...Array.from(new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text), (p) => p.index + p.segment.length)]);
  for (let n = 0; n <= text.length; n++) {
    const end = safePrefixLength(text, n);
    expect(ends.has(end)).toBe(true);
    expect(end).toBeLessThanOrEqual(n);
  }
});
test("identity includes owner and reset generation, not last chunk sequence", () => {
  const a = { sessionId: "a", turnKey: "a:1", generation: 1 };
  expect(streamIdentityKey(a)).toBe(streamIdentityKey({ ...a }));
  expect(streamIdentityKey(a)).not.toBe(streamIdentityKey({ ...a, generation: 2 }));
  expect(streamIdentityKey(a)).not.toBe(streamIdentityKey({ ...a, sessionId: "b" }));
});
