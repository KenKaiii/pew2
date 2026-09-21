import { expect, test } from "bun:test";
import { contextDetails } from "./contextDetails";
const workspace = { cwd: "/repo", folder: "repo", repo: true, uncommitted: 0 };
test("routine usage and clean state remain available in details but not resting warnings", () => {
  const details = contextDetails(workspace, { used: 2000, size: 100000 });
  expect(details.warning).toBe(false);
  expect(details.dirty).toBe(false);
  expect(details.usage).toBe("2%");
  expect(details.changes).toBe("clean");
  expect(details.changesAccessibility).toBe("Working directory clean");
});
test("retains the existing high/critical thresholds and all nonzero changes", () => {
  for (const [used, expected] of [[74, false], [75, true], [89, true], [90, true]] as const) {
    expect(contextDetails(workspace, { used, size: 100 }).warning).toBe(expected);
  }
  const details = contextDetails({ ...workspace, uncommitted: 137 }, { used: 90, size: 100 });
  expect(details.level).toBe("critical");
  expect(details.usageAccessibility).toContain("Compaction is close");
  expect(details.dirty).toBe(true);
  expect(details.changes).toBe("137 uncommitted");
});
test("unknown and invalid data never become zero or clean", () => {
  const missing = contextDetails();
  expect(missing.project).toBe("Unknown project");
  expect(missing.usage).toBe("Context usage unavailable");
  expect(missing.changes).toBe("Change count unavailable");
  expect(contextDetails(workspace, { used: 1, size: 0 }).usage).toBe(missing.usage);
  expect(contextDetails({ ...workspace, uncommitted: NaN }).changes).toBe(missing.changes);
  expect(contextDetails({ ...workspace, uncommitted: undefined }).changes).toBe(missing.changes);
  expect(contextDetails({ ...workspace, repo: undefined }).changes).toBe(missing.changes);
  expect(contextDetails({ ...workspace, repo: false }).changes).toBe("Not a Git repository");
});
