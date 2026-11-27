import { describe, expect, test } from "bun:test";
import { ggStrips, goalDrawerRow, isGoalsProvider, suggestGoalName } from "./goalsAgent";

describe("ggStrips", () => {
  test("never shows autopilot/checklist/plan for gg-goals", () => {
    expect(ggStrips("gg-goals", { autopilot: true, checklist: true, tasks: true }, true)).toEqual({
      autopilot: false,
      checklist: false,
      tasks: false,
      plan: false,
    });
  });
  test("follows extensions for ggcoder", () => {
    expect(ggStrips("ggcoder", { autopilot: true }, true)).toEqual({
      autopilot: true,
      checklist: false,
      tasks: false,
      plan: true,
    });
    expect(ggStrips("ggcoder", undefined, true).autopilot).toBe(false);
    // An older daemon never says `tasks`, so it gets no Tasks chip.
    expect(ggStrips("ggcoder", { checklist: true }, true).tasks).toBe(false);
    expect(ggStrips("ggcoder", { tasks: true }, true).tasks).toBe(true);
  });
  test("nothing without a session", () => {
    expect(ggStrips("ggcoder", { autopilot: true, checklist: true }, false).autopilot).toBe(false);
    expect(ggStrips("ggcoder", { tasks: true }, false).tasks).toBe(false);
  });
  test("isGoalsProvider", () => {
    expect(isGoalsProvider("gg-goals")).toBe(true);
    expect(isGoalsProvider("ggcoder")).toBe(false);
    expect(isGoalsProvider(undefined)).toBe(false);
  });
});

describe("suggestGoalName", () => {
  test("first words, capitalised, punctuation trimmed", () => {
    expect(suggestGoalName("get checkout loading under one second, please")).toBe(
      "Get checkout loading under",
    );
    expect(suggestGoalName("  ship the docs!\nthen more")).toBe("Ship the docs then");
  });
  test("caps length and handles empty", () => {
    expect(suggestGoalName("")).toBe("");
    expect(suggestGoalName("a".repeat(60)).length).toBe(40);
  });
});

describe("goalDrawerRow", () => {
  const goal = {
    id: "g1",
    name: "Pew2-gg",
    status: "interrupted",
    path: "/goals/g1",
    lastActiveMs: 5,
  };
  test("reads like a chat row: title, then status · when", () => {
    const { row, meta } = goalDrawerRow(goal, "11m ago");
    expect(row.title).toBe("Pew2-gg");
    expect(row.busy).toBe(false);
    expect(meta).toBe("Interrupted · 11m ago");
  });
  test("an idle goal shows only when it was last active", () => {
    expect(goalDrawerRow({ ...goal, status: "idle" }, "5h ago").meta).toBe("5h ago");
  });
  test("a running goal gets the busy dot", () => {
    expect(goalDrawerRow({ ...goal, status: "running" }, "just now").row.busy).toBe(true);
  });
});
