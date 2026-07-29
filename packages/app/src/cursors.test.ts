/**
 * Cursor tests.
 *
 * These encode the rules that make reconnecting gap-free rather than
 * duplicate-ridden: forward-only, per-session, and duplicate-aware.
 */
import { test, expect } from "bun:test";
import { advance, alreadySeen, type Cursors } from "./cursors";

test("records the highest seq per session", () => {
  let cursors: Cursors = {};

  cursors = advance(cursors, "s1", 0);
  cursors = advance(cursors, "s1", 1);
  cursors = advance(cursors, "s1", 2);

  expect(cursors).toEqual({ s1: 2 });
});

test("never rewinds on a duplicate or out-of-order event", () => {
  let cursors: Cursors = advance({}, "s1", 5);

  // Replay overlaps the live stream, so older events genuinely do arrive after
  // newer ones. Rewinding would re-request everything already on screen.
  cursors = advance(cursors, "s1", 3);
  cursors = advance(cursors, "s1", 5);

  expect(cursors.s1).toBe(5);
});

test("keeps sessions independent", () => {
  let cursors: Cursors = {};

  // `seq` restarts at 0 for every session, so one shared counter would ask the
  // relay for the wrong range on every session but the newest.
  cursors = advance(cursors, "s1", 7);
  cursors = advance(cursors, "s2", 1);

  expect(cursors).toEqual({ s1: 7, s2: 1 });
});

test("returns the same object when nothing changed", () => {
  const cursors = advance({}, "s1", 4);

  // Identity is the cheap signal that no state update is needed.
  expect(advance(cursors, "s1", 4)).toBe(cursors);
  expect(advance(cursors, "s1", 2)).toBe(cursors);
});

test("ignores malformed sequence numbers", () => {
  const cursors = advance({}, "s1", 3);

  // A daemon or relay of a different version must not be able to corrupt the
  // cursor into something that requests nonsense on the next reconnect.
  for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    expect(advance(cursors, "s1", bad)).toBe(cursors);
  }
});

test("seq 0 is a real cursor, not an absent one", () => {
  const cursors = advance({}, "s1", 0);

  // The first event of every session is seq 0, so treating it as falsy would
  // re-replay the whole session on every reconnect.
  expect(cursors.s1).toBe(0);
  expect(alreadySeen(cursors, "s1", 0)).toBe(true);
});

test("recognises events already applied, and only those", () => {
  const cursors = advance({}, "s1", 4);

  expect(alreadySeen(cursors, "s1", 3)).toBe(true);
  expect(alreadySeen(cursors, "s1", 4)).toBe(true);
  expect(alreadySeen(cursors, "s1", 5)).toBe(false);
  // An unknown session has seen nothing, so nothing can be a duplicate.
  expect(alreadySeen(cursors, "other", 0)).toBe(false);
});

test("an empty cursor map asks for the whole history", () => {
  // What a first connection sends. The relay reads "no cursor" as "send
  // everything", which is what makes a fresh device show existing history.
  expect(advance({}, "s1", 0)).toEqual({ s1: 0 });
  expect(alreadySeen({}, "s1", 0)).toBe(false);
});
