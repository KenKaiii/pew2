import { describe, expect, test } from "bun:test";

import { dockHeightFor, recordDockHeight, type DockHeights } from "./dockHeight";

const FALLBACK = 100;

describe("dockHeightFor", () => {
  test("switching to a state already measured needs no new measurement", () => {
    // The point of the whole thing. Both states have been on screen once, so
    // opening the keyboard again knows the inset immediately instead of waiting
    // for the dock to lay out and report — which is what made the transcript
    // re-seat a few frames after the keyboard had finished arriving.
    const heights: DockHeights = { typing: 80, resting: 140 };
    expect(dockHeightFor(heights, false, FALLBACK)).toBe(140);
    expect(dockHeightFor(heights, true, FALLBACK)).toBe(80);
  });

  test("the first keyboard open falls back to the other state, not to nothing", () => {
    // Only reachable once per launch. The resting height is a real measurement
    // of this dock and differs from the typing one by the context row, so it is
    // a much better guess than the analytic fallback and far better than zero,
    // which would put the last message hard against the composer for a frame.
    const firstOpen: DockHeights = { typing: 0, resting: 140 };
    expect(dockHeightFor(firstOpen, true, FALLBACK)).toBe(140);
  });

  test("before anything is measured, the analytic height stands in", () => {
    expect(dockHeightFor({ typing: 0, resting: 0 }, false, FALLBACK)).toBe(FALLBACK);
    expect(dockHeightFor({ typing: 0, resting: 0 }, true, FALLBACK)).toBe(FALLBACK);
  });
});

describe("recordDockHeight", () => {
  test("an unchanged height keeps the same object", () => {
    // The dock lays out repeatedly across the keyboard's animation. A new object
    // per pass would re-render the transcript on those frames, which is exactly
    // the per-frame relayout the lift transform exists to avoid.
    const heights: DockHeights = { typing: 80, resting: 140 };
    expect(recordDockHeight(heights, false, 140)).toBe(heights);
    expect(recordDockHeight(heights, true, 80)).toBe(heights);
  });

  test("each state records against itself", () => {
    // A single height meant the typing measurement overwrote the resting one, so
    // whichever state was measured last decided the inset for both.
    const start: DockHeights = { typing: 0, resting: 140 };
    const afterTyping = recordDockHeight(start, true, 80);
    expect(afterTyping).toEqual({ typing: 80, resting: 140 });
    expect(recordDockHeight(afterTyping, false, 150)).toEqual({ typing: 80, resting: 150 });
  });
});
