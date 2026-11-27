import { describe, expect, test } from "bun:test";
import {
  checklistRunPrompt,
  decidedPlan,
  groupChecklist,
  readGgEvent,
  readPlan,
  readPlanAcceptedSession,
  type ChecklistItem,
} from "./ggReview";
import { applyReplayExtras, applyReviewMessage, EMPTY_GG } from "./ggState";
import { readChunk } from "./chunks";

const item = (id: string, group: string, status: ChecklistItem["status"]): ChecklistItem => ({
  id,
  group,
  title: id,
  description: "",
  status,
  checkedAt: null,
  result: null,
  summary: null,
  findings: [],
  evidence: [],
  changedSinceCheck: false,
  detection: null,
  runPrompt: null,
});

describe("plan state", () => {
  const pending = { planPath: "p.md", content: "# Plan", generation: 3 };
  test("live plan.state opens a pending plan; decide clears only that generation", () => {
    const s = applyReviewMessage(EMPTY_GG, {
      t: "plan.state",
      sessionId: "s",
      planMode: true,
      pending,
    });
    expect(s.plans.s?.pending?.generation).toBe(3);
    expect(decidedPlan(s.plans.s, 2)?.pending).not.toBeNull();
    expect(decidedPlan(s.plans.s, 3)?.pending).toBeNull();
  });
  test("replay: absent says nothing, null pending clears, events never open", () => {
    const open = applyReplayExtras(EMPTY_GG, {
      sessionId: "s",
      plan: { planMode: false, pending },
    });
    expect(applyReplayExtras(open, { sessionId: "s" })).toBe(open);
    expect(
      applyReplayExtras(open, { sessionId: "s", plan: { planMode: false, pending: null } }).plans.s
        ?.pending,
    ).toBeNull();
    expect(readPlan({ pending })).toBeUndefined();
  });
  test("autopilot replay and checklist nudge", () => {
    const s = applyReplayExtras(EMPTY_GG, {
      sessionId: "s",
      autopilot: { enabled: true, reviewing: true },
    });
    expect(s.autopilot.s).toEqual({ enabled: true, reviewing: true });
    expect(
      applyReviewMessage(s, { t: "checklist", sessionId: "s", changed: true }).checklistNonce,
    ).toBe(1);
  });
});

describe("transcript rows", () => {
  test("plan events", () => {
    expect(readGgEvent({ kind: "plan_accepted", planTotal: 4 })?.text).toBe(
      "Plan accepted · fresh context · 4 steps",
    );
    expect(
      readGgEvent({ kind: "plan_decision", action: "feedback", feedback: "smaller" })?.text,
    ).toBe("Plan feedback: smaller");
    expect(readChunk({ kind: "plan_decision", action: "reject" })).toEqual({
      role: "note",
      text: "Plan rejected",
    });
  });
  test("autopilot phases", () => {
    expect(readGgEvent({ kind: "autopilot", phase: "review_start" })).toBeUndefined();
    expect(readGgEvent({ kind: "autopilot", phase: "ignored" })).toBeUndefined();
    expect(
      readGgEvent({ kind: "autopilot", phase: "prompted", body: "fix tests", round: 2 }),
    ).toEqual({ role: "ken", text: "fix tests", ken: { phase: "prompted", round: 2 } });
    expect(readGgEvent({ kind: "autopilot", phase: "human", reason: "pick a db" })?.text).toBe(
      "Over to you: pick a db",
    );
    expect(readGgEvent({ kind: "autopilot", phase: "error", reason: "x" })?.role).toBe("ken");
    expect(readGgEvent({ kind: "plan_accepted", planTotal: 3 })?.role).toBe("note");
  });
});

test("checklist groups keep first-seen order, attention first", () => {
  const groups = groupChecklist([
    item("a", "G1", "passed"),
    item("b", "G2", "due"),
    item("c", "G1", "needs-work"),
  ]);
  expect(groups.map((g) => g.group)).toEqual(["G1", "G2"]);
  expect(groups[0]?.items.map((i) => i.id)).toEqual(["c", "a"]);
});

test("the setup item runs /init; others their own prompt", () => {
  expect(checklistRunPrompt({ id: "agent-setup", runPrompt: "x" })).toBe("/init");
  expect(checklistRunPrompt({ id: "tests", runPrompt: "run tests" })).toBe("run tests");
  expect(checklistRunPrompt({ id: "tests", runPrompt: null })).toBeNull();
});

test("Ken rows keep their own role and never coalesce", async () => {
  const { applyChunk } = await import("./replayFold");
  const ken = readChunk({ kind: "autopilot", phase: "done" });
  const capped = readChunk({ kind: "autopilot", phase: "capped" });
  if (!ken || !capped) throw new Error("expected Ken rows");
  expect(ken.role).toBe("ken");
  const turns: Parameters<typeof applyChunk>[0] = [];
  applyChunk(turns, "s:1", ken);
  applyChunk(turns, "s:2", capped);
  expect(turns.map((t) => t.ken?.phase)).toEqual(["done", "capped"]);
});

test("readPlanAcceptedSession reads the implementation's agent session from plan_accepted only", () => {
  expect(readPlanAcceptedSession({ kind: "plan_accepted", agentSessionId: "gg_impl" })).toBe(
    "gg_impl",
  );
  expect(readPlanAcceptedSession({ kind: "plan_accepted", planTotal: 3 })).toBeUndefined();
  expect(readPlanAcceptedSession({ kind: "plan_accepted", agentSessionId: "" })).toBeUndefined();
  expect(readPlanAcceptedSession({ kind: "context_reset", agentSessionId: "x" })).toBeUndefined();
  expect(readPlanAcceptedSession(null)).toBeUndefined();
});
