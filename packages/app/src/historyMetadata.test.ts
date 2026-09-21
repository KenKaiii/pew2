import { expect, test } from "bun:test";
import { replaceAgentSessionStub } from "./agentHistory";
import { formatHistoryMetadata, projectDrawerRows } from "./historyMetadata";

const row: Session = { id: "a", providerId: "gg", title: "Title", startedAt: 1, turns: [{ id: "a:1", role: "agent", text: "hello" }], configOptions: [] };
test("drawer projection retains array and row identity during text-only growth", () => {
  const before = projectDrawerRows([], [row]);
  const after = projectDrawerRows(before, [{ ...row, turns: [{ ...row.turns[0]!, text: "hello world" }] }]);
  expect(after).toBe(before);
  expect(after[0]).toBe(before[0]);
  expect("turns" in after[0]!).toBe(false);
});
test("drawer preserves legitimate count changes and eviction", () => {
  const before = projectDrawerRows([], [row]);
  const after = projectDrawerRows(before, [{ ...row, turns: [...row.turns, { id: "a:2", role: "user", text: "next" }] }]);
  expect(after[0]).not.toBe(before[0]);
  expect(after[0]!.messageCount).toBe(2);
  expect(projectDrawerRows(after, [])).toEqual([]);
});
test("every displayed field invalidates the projection; unrelated config does not", () => {
  const before = projectDrawerRows([], [row]);
  const changes: Partial<Session>[] = [
    { id: "b" }, { providerId: "other" }, { title: "new" }, { startedAt: 2 },
    { cwd: "/repo" }, { folder: "repo" }, { busy: true }, { unread: true },
    { permission: { requestId: "p", options: [], title: "Approve" } },
  ];
  for (const change of changes) expect(projectDrawerRows(before, [{ ...row, ...change }])[0]).not.toBe(before[0]);
  expect(projectDrawerRows(before, [{ ...row, configOptions: [] }])).toBe(before);
  expect(projectDrawerRows([], [{ ...row, turns: [], messageCount: 7 }])[0]!.messageCount).toBe(7);
});
import type { Session } from "./useDaemon";

test("resumed history renders message count and retained working directory", () => {
  const stub: Session = {
    id: "agent:claude-code:disk-session",
    providerId: "claude-code",
    title: "Fix the build",
    startedAt: 1,
    turns: [],
    configOptions: [],
    agentSessionId: "disk-session",
    cwd: "/Users/kenkai/gg-projects/pew2",
  };
  const live: Session = {
    ...stub,
    id: "live-session",
    turns: [
      { id: "live-session:0", role: "user", text: "Fix it" },
      { id: "live-session:1", role: "agent", text: "Done" },
    ],
    cwd: undefined,
  };

  const [resumed] = replaceAgentSessionStub([stub], live);

  expect(resumed!.cwd).toBe("/Users/kenkai/gg-projects/pew2");
  expect(formatHistoryMetadata(resumed!)).toBe("2 messages · pew2");
});

test("agent metadata renders a message count before the session is opened", () => {
  const stub: Session = {
    id: "agent:ggcoder:disk-session",
    providerId: "ggcoder",
    title: "Keep history visible",
    startedAt: 1,
    turns: [],
    messageCount: 7,
    configOptions: [],
    agentSessionId: "disk-session",
    cwd: "/Users/kenkai/gg-projects/pew2",
  };

  expect(formatHistoryMetadata(stub)).toBe("7 messages · pew2");
});

test("a session started from the phone is named by the folder the daemon stamped", () => {
  // It has no `cwd` of its own — only the desktop knows where the agent runs,
  // and it says so when the turn finishes.
  const session: Session = {
    id: "live-session",
    providerId: "claude-code",
    title: "Add notifications",
    startedAt: 1,
    turns: [
      { id: "live-session:0", role: "user", text: "Add them" },
      { id: "live-session:1", role: "agent", text: "Done" },
    ],
    configOptions: [],
    folder: "pew2",
  };

  expect(formatHistoryMetadata(session)).toBe("2 messages · pew2");
});
