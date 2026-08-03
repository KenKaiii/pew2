/**
 * The drawer must list conversations the connected agent already had on disk,
 * including ones this app never started — that is the whole point of a remote
 * control for a desktop agent.
 */
import { test, expect } from "bun:test";
import {
  mergeAgentSessions,
  agentSessionKey,
  isAgentSessionStub,
  needsResume,
} from "./agentHistory";
import type { Session } from "./useDaemon";

const NOW = 1_700_000_000_000;

const local: Session = {
  id: "claude-code-abc",
  providerId: "claude-code",
  title: "Started on this phone",
  startedAt: NOW,
  turns: [{ id: "claude-code-abc:0", role: "user", text: "hi" }],
  configOptions: [],
};

test("conversations from the agent's disk appear in the list", () => {
  const merged = mergeAgentSessions(
    [],
    "claude-code",
    [
      {
        sessionId: "s1",
        cwd: "/repo",
        title: "Fix the build",
        updatedAt: "2026-07-29T04:29:51Z",
        messageCount: 12,
      },
      { sessionId: "s2", cwd: "/other", title: "Ship the API", updatedAt: "2026-07-28T10:00:00Z" },
    ],
    true,
    NOW,
  );

  expect(merged.map((s) => s.title)).toEqual(["Fix the build", "Ship the API"]);
  // Stubs: the turns live on the agent and only arrive on resume.
  expect(merged.every((s) => s.turns.length === 0)).toBe(true);
  expect(merged[0]!.agentSessionId).toBe("s1");
  expect(merged[0]!.cwd).toBe("/repo");
  expect(merged[0]!.id).toBe(agentSessionKey("claude-code", "s1"));
  expect(merged[0]!.messageCount).toBe(12);
});

test("a session started here is not listed again as the agent's own", () => {
  // The daemon reports the agent's id for sessions this app started, so the
  // next history probe recognises the conversation already on screen. Without
  // that, it appeared twice and reopening the copy lost the session's model.
  const live: Session = { ...local, agentSessionId: "s1" };
  const merged = mergeAgentSessions(
    [live],
    "claude-code",
    [{ sessionId: "s1", cwd: "/repo", title: "Started on this phone" }],
    true,
    NOW,
  );

  expect(merged).toEqual([live]);
  // ...and it still opens from memory rather than reloading from the agent.
  expect(isAgentSessionStub(live.id)).toBe(false);
  expect(isAgentSessionStub(agentSessionKey("claude-code", "s1"))).toBe(true);
  expect(needsResume(live, new Set([live.id]))).toBe(false);
});

test("a session the daemon no longer holds is reopened, not prompted", () => {
  // Session ids belong to a daemon *process*. The drawer outlives it, so after
  // a daemon restart an entry can name an id that is gone — which is what
  // answered "Unknown session" on the next prompt.
  const survivor: Session = { ...local, agentSessionId: "s1" };

  expect(needsResume(survivor, new Set(["some-other-session"]))).toBe(true);
  expect(needsResume(survivor, new Set([survivor.id]))).toBe(false);

  // The agent's own copy always reloads: its turns were never in this app.
  const stub: Session = {
    ...local,
    id: agentSessionKey("claude-code", "s1"),
    agentSessionId: "s1",
  };
  expect(needsResume(stub, new Set([stub.id]))).toBe(true);
});

test("nothing is reopened when the daemon never reported its sessions", () => {
  // An older daemon says nothing about which sessions it holds. Guessing they
  // are all dead would reload every conversation the user opens.
  expect(needsResume({ ...local, agentSessionId: "s1" }, undefined)).toBe(false);
  // ...and a conversation with no agent id has nothing to reopen from, so it
  // is shown from memory whatever the daemon says.
  expect(needsResume(local, new Set())).toBe(false);
});

test("newest first, so the thread just worked on is at the top", () => {
  const merged = mergeAgentSessions(
    [],
    "claude-code",
    [
      { sessionId: "old", cwd: "/r", title: "Old", updatedAt: "2020-01-01T00:00:00Z" },
      { sessionId: "new", cwd: "/r", title: "New", updatedAt: "2026-01-01T00:00:00Z" },
    ],
    true,
    NOW,
  );

  expect(merged.map((s) => s.title)).toEqual(["New", "Old"]);
});

test("an agent that cannot reopen sessions contributes none", () => {
  const merged = mergeAgentSessions(
    [local],
    "echo",
    [{ sessionId: "s1", cwd: "/r", title: "Unreachable" }],
    false,
    NOW,
  );

  expect(merged).toBe(local ? merged : merged);
  expect(merged).toEqual([local]);
});

test("a session already tracked here is not duplicated by the agent's copy", () => {
  const resumed: Session = { ...local, agentSessionId: "s1" };

  const merged = mergeAgentSessions(
    [resumed],
    "claude-code",
    [{ sessionId: "s1", cwd: "/repo", title: "Same thread, agent's name for it" }],
    true,
    NOW,
  );

  expect(merged).toHaveLength(1);
  expect(merged[0]!.title).toBe("Started on this phone");
});

test("local sessions keep their turns when agent history merges in", () => {
  const merged = mergeAgentSessions(
    [local],
    "claude-code",
    [{ sessionId: "s9", cwd: "/r", title: "From disk", updatedAt: "2026-01-01T00:00:00Z" }],
    true,
    NOW,
  );

  expect(merged).toHaveLength(2);
  expect(merged.find((s) => s.id === local.id)!.turns).toHaveLength(1);
});

test("an untitled or undated session still lists, and sorts as recent", () => {
  const merged = mergeAgentSessions(
    [],
    "claude-code",
    [
      { sessionId: "dated", cwd: "/r", title: "Dated", updatedAt: "2020-01-01T00:00:00Z" },
      { sessionId: "bare", cwd: "/r" },
      { sessionId: "bad", cwd: "/r", title: "  ", updatedAt: "not-a-date" },
    ],
    true,
    NOW,
  );

  expect(merged.map((s) => s.title)).toEqual([
    "Untitled conversation",
    "Untitled conversation",
    "Dated",
  ]);
});

test("nothing to add returns the same array, so no re-render is queued", () => {
  const before = [local];
  expect(mergeAgentSessions(before, "claude-code", [], true, NOW)).toBe(before);
  expect(mergeAgentSessions(before, undefined, undefined, true, NOW)).toBe(before);
});
