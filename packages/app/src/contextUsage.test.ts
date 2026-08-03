import { expect, test } from "bun:test";
import {
  readUsage,
  usageAccessibilityLabel,
  usageLabel,
  usageLevel,
  usagePercent,
} from "./contextUsage";

test("a real Claude Code reading renders as a small percentage", () => {
  // Captured from a live session: 21,325 of a 1,000,000-token window.
  expect(usageLabel({ used: 21325, size: 1000000 })).toBe("2%");
});

test("tokens already spent never read as 0%", () => {
  // A fresh session holds a system prompt. A meter at zero while tokens are
  // plainly being used reads as broken, so anything above nothing is at least 1%.
  expect(usagePercent({ used: 500, size: 1000000 })).toBe(1);
  expect(usagePercent({ used: 0, size: 1000000 })).toBe(0);
});

test("a missing or nonsense window is 0%, never a division by zero", () => {
  expect(usagePercent({ used: 100, size: 0 })).toBe(0);
});

test("an overfull window clamps rather than reporting 104%", () => {
  expect(usagePercent({ used: 1040, size: 1000 })).toBe(100);
});

test("the bands escalate at 75 and 90", () => {
  expect(usageLevel(74)).toBe("normal");
  expect(usageLevel(75)).toBe("high");
  expect(usageLevel(89)).toBe("high");
  expect(usageLevel(90)).toBe("critical");
});

test("the spoken form says what the number means, and names the risk when close", () => {
  expect(usageAccessibilityLabel({ used: 21325, size: 1000000 })).toBe(
    "2% of context used, 21,325 of 1,000,000 tokens",
  );
  expect(usageAccessibilityLabel({ used: 950, size: 1000 })).toContain("Compaction is close.");
});

test("a reading is only taken from a usage_update", () => {
  expect(readUsage({ update: { sessionUpdate: "agent_message_chunk" } })).toBeUndefined();
  expect(readUsage(undefined)).toBeUndefined();
  expect(readUsage({ update: { sessionUpdate: "usage_update", used: 10, size: 1000 } })).toEqual({
    used: 10,
    size: 1000,
  });
});

test("non-numeric tokens are rejected rather than rendered as NaN%", () => {
  // This crosses a wire from a process the app does not control.
  expect(
    readUsage({ update: { sessionUpdate: "usage_update", used: "10", size: 1000 } }),
  ).toBeUndefined();
  expect(
    readUsage({ update: { sessionUpdate: "usage_update", used: 10, size: Infinity } }),
  ).toBeUndefined();
});
