import { expect, test } from "bun:test";
import { contextResetText, groupTasks, readContextReset, runBlockedReason } from "./ggTasks";
import type { TaskItem } from "./ggState";

const task = (id: string, status: TaskItem["status"]): TaskItem => ({
  id,
  title: id,
  prompt: `do ${id}`,
  status,
  runPrompt: status === "pending" ? `do ${id}` : null,
});

test("bands run in progress, to do, done, keeping file order and dropping empty bands", () => {
  const groups = groupTasks([
    task("a", "done"),
    task("b", "pending"),
    task("c", "in-progress"),
    task("d", "pending"),
  ]);
  expect(groups.map((g) => [g.label, g.items.map((t) => t.id)])).toEqual([
    ["In progress", ["c"]],
    ["To do", ["b", "d"]],
    ["Done", ["a"]],
  ]);
  expect(groupTasks([task("x", "pending")]).map((g) => g.band)).toEqual(["pending"]);
  expect(groupTasks([])).toEqual([]);
});

test("a context_reset event reads as the task title and the new agent session", () => {
  const reset = readContextReset({
    kind: "context_reset",
    reason: "task",
    title: " Fix login ",
    agentSessionId: "gg_2",
  });
  expect(reset).toEqual({ title: "Fix login", agentSessionId: "gg_2" });
  expect(contextResetText(reset!)).toBe("Task: Fix login");
  expect(readContextReset({ kind: "context_reset" })).toEqual({ title: "" });
  expect(contextResetText({ title: "" })).toBe("Task");
  expect(readContextReset({ kind: "plan_accepted" })).toBeUndefined();
  expect(readContextReset(null)).toBeUndefined();
});

test("Run waits for a connection, then for the agent to stop", () => {
  expect(runBlockedReason(true, false)).toBeUndefined();
  expect(runBlockedReason(true, true)).toBe("Run this once GG Coder stops");
  expect(runBlockedReason(false, false)).toBe("Reconnect to run this task");
  expect(runBlockedReason(false, true)).toBe("Reconnect to run this task");
});
