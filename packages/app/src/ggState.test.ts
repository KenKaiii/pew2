import { expect, test } from "bun:test";
import {
  applyGoalMessage,
  applyLiveEvent,
  applyQueue,
  applyReplayExtras,
  applyTasksMessage,
  closeAsk,
  dropQueued,
  EMPTY_GG,
  elapsedLabel,
  goalForSession,
  lastActiveLabel,
  markTaskStarted,
  sortGoals,
  workerElapsed,
  type GoalState,
  type GoalSummary,
} from "./ggState";

const ask = {
  kind: "ask_user",
  requestId: "r1",
  questions: [{ id: "q", question: "?", kind: "text" }],
};
const goal = (id: string, extra: Partial<GoalSummary> = {}): GoalSummary => ({
  id,
  name: id,
  goal: "do it",
  context: [],
  path: `/g/${id}`,
  createdAt: "",
  lastActiveMs: 0,
  status: "idle",
  ...extra,
});
const state: GoalState = {
  t: "goal.state",
  sessionId: "s1",
  goalId: "g1",
  phase: "active",
  paused: false,
  workers: [],
};

test("session.queue replaces the list per session and records returned", () => {
  let gg = applyQueue(EMPTY_GG, { sessionId: "s1", queued: [{ id: "q_1", text: "a" }] });
  gg = applyQueue(gg, { sessionId: "s2", queued: [{ id: "q_2", text: "b" }] });
  expect(gg.queues).toEqual({ s1: [{ id: "q_1", text: "a" }], s2: [{ id: "q_2", text: "b" }] });
  gg = applyQueue(gg, { sessionId: "s1", queued: [], returned: [{ id: "q_1", text: "a" }] });
  expect(gg.queues.s1).toBeUndefined();
  expect(gg.returned).toEqual({ sessionId: "s1", messages: [{ id: "q_1", text: "a" }], nonce: 1 });
  expect(dropQueued(gg, "s2", "q_2").queues).toEqual({});
});

test("replay extras: absent says nothing, [] clears, never opens from events", () => {
  let gg = applyLiveEvent(EMPTY_GG, "s1", ask);
  gg = applyQueue(gg, { sessionId: "s1", queued: [{ id: "q", text: "x" }] });
  const same = applyReplayExtras(gg, { sessionId: "s1" });
  expect(same).toBe(gg);
  const cleared = applyReplayExtras(gg, { sessionId: "s1", asks: [], queued: [] });
  expect(cleared.asks.s1).toBeUndefined();
  expect(cleared.queues.s1).toBeUndefined();
  const restored = applyReplayExtras(EMPTY_GG, { sessionId: "s1", asks: [ask], goal: state });
  expect(restored.asks.s1?.[0]?.requestId).toBe("r1");
  expect(restored.goalStates.s1).toEqual(state);
});

test("asks open live once, close on answer or a closed event, never on idle", () => {
  const gg = applyLiveEvent(EMPTY_GG, "s1", ask);
  expect(applyLiveEvent(gg, "s1", ask)).toBe(gg);
  expect(applyLiveEvent(gg, "s1", { kind: "user_message", text: "hi" })).toBe(gg);
  expect(closeAsk(gg, "s1", "r1").asks).toEqual({});
  // GG Coder keeps a question open past the turn that asked it (late answers).
  expect(applyLiveEvent(gg, "s1", { kind: "ask_user_closed", requestId: "r1" }).asks).toEqual({});
  expect(applyLiveEvent(gg, "s1", { kind: "ask_user_closed", requestId: "other" })).toBe(gg);
});

test("goal frames", () => {
  let gg = applyGoalMessage(
    { ...EMPTY_GG, goalsLoading: true },
    { t: "goals", goals: [goal("g1")] },
  );
  expect(gg.goals?.length).toBe(1);
  expect(gg.goalsLoading).toBe(false);
  gg = applyGoalMessage(gg, { t: "goals", goals: [], error: "no ggcoder" });
  expect(gg.goalsError).toBe("no ggcoder");
  expect(gg.goals?.length).toBe(1);
  gg = applyGoalMessage(gg, { t: "goal.result", requestId: "r", ok: true });
  expect(gg.goalResults.r?.ok).toBe(true);
  gg = applyGoalMessage(gg, { ...state });
  expect(gg.goalStates.s1?.goalId).toBe("g1");
});

test("goal lookup and labels", () => {
  const goals = [goal("g1", { sessionId: "s9" }), goal("g2", { lastActiveMs: 5 })];
  expect(goalForSession(goals, { sessionId: "s9" })?.id).toBe("g1");
  expect(goalForSession(goals, { cwd: "/g/g2" })?.id).toBe("g2");
  expect(goalForSession(goals, {}, { ...state, goalId: "g2" })?.id).toBe("g2");
  expect(goalForSession(undefined, { cwd: "/g/g2" })).toBeUndefined();
  expect(sortGoals(goals).map((g) => g.id)).toEqual(["g2", "g1"]);
  expect(lastActiveLabel(0, 30_000)).toBe("just now");
  expect(lastActiveLabel(0, 5 * 60_000)).toBe("5m ago");
  expect(lastActiveLabel(0, 3 * 3_600_000)).toBe("3h ago");
  expect(lastActiveLabel(0, 49 * 3_600_000)).toBe("2d ago");
  expect(elapsedLabel(65_000)).toBe("1m 05s");
  expect(elapsedLabel(undefined)).toBe("");
  expect(workerElapsed({ id: "w", name: "w", state: "running", startedAt: 1000 }, 4000)).toBe(3000);
  expect(
    workerElapsed({ id: "w", name: "w", state: "completed", startedAt: 1000, elapsedMs: 7 }, 4000),
  ).toBe(7);
});

test("tasks frames replace the session's list, drop malformed rows, and carry errors", () => {
  const row = {
    id: "a",
    title: "A",
    prompt: "do a",
    status: "pending" as const,
    runPrompt: "do a!",
  };
  let g = applyTasksMessage(EMPTY_GG, {
    t: "tasks",
    requestId: "r1",
    sessionId: "s",
    items: [row, { id: "b", title: "B", prompt: "x", status: "blocked", runPrompt: null }, "junk"],
  });
  expect(g.tasks.s).toEqual({ items: [row], error: undefined, requestId: "r1" });
  g = applyTasksMessage(g, { t: "tasks", sessionId: "s", error: "Unknown session 's'" });
  expect(g.tasks.s).toEqual({
    items: undefined,
    error: "Unknown session 's'",
    requestId: undefined,
  });
  expect(applyTasksMessage(EMPTY_GG, { t: "tasks", items: [row] })).toBe(EMPTY_GG);
  expect(applyTasksMessage(EMPTY_GG, { t: "checklist", sessionId: "s" })).toBe(EMPTY_GG);
});

test("a started task shows in progress at once and can no longer be run", () => {
  const g = applyTasksMessage(EMPTY_GG, {
    t: "tasks",
    sessionId: "s",
    items: [
      { id: "a", title: "A", prompt: "do a", status: "pending", runPrompt: "do a!" },
      { id: "b", title: "B", prompt: "do b", status: "pending", runPrompt: "do b!" },
    ],
  });
  const started = markTaskStarted(g, "s", "a");
  expect(started.tasks.s?.items?.map((t) => [t.status, t.runPrompt])).toEqual([
    ["in-progress", null],
    ["pending", "do b!"],
  ]);
  expect(markTaskStarted(EMPTY_GG, "s", "a")).toBe(EMPTY_GG);
});
