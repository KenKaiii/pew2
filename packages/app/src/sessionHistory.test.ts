import { expect, test } from "bun:test";
import type { Session } from "./useDaemon";
import { recentSessionsForProvider, SESSION_HISTORY_LIMIT } from "./sessionHistory";

function session(index: number, providerId = "ggcoder"): Session {
  return {
    id: `session-${index}`,
    providerId,
    title: `Session ${index}`,
    startedAt: 100 - index,
    turns: [],
    configOptions: [],
  };
}

test("the drawer shows only the 30 most recent sessions for an app", () => {
  const sessions = [
    ...Array.from({ length: 36 }, (_, index) => session(index)),
    session(99, "claude-code"),
  ];

  const visible = recentSessionsForProvider(sessions, "ggcoder");

  expect(visible).toHaveLength(SESSION_HISTORY_LIMIT);
  expect(visible[0]?.id).toBe("session-0");
  expect(visible.at(-1)?.id).toBe("session-29");
});
