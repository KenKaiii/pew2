import { describe, expect, it } from "bun:test";
import { IDLE_ACTIVITY } from "./activity";
import { reduceMessage, type MessageScope } from "./daemonReducer";
import type { State } from "./daemonState";

function start(): State {
  return {
    status: "online",
    providers: [],
    turns: [],
    sessions: [],
    configOptions: [],
    commands: [],
    busy: false,
    activity: IDLE_ACTIVITY,
    loadingSessions: false,
    heard: false,
    loadingSession: false,
    projects: {},
    projectPath: {},
    workspaceNonce: 0,
  };
}

function scope(pending: string[]): MessageScope {
  return {
    sessionRef: { current: undefined },
    pendingCapabilities: { current: new Set(pending) },
    claimsScreen: false,
    adoptedRequestId: undefined,
    completedTurn: undefined,
    now: 0,
  };
}

const agents = [
  { id: "claude", name: "Claude Code", available: true },
  { id: "codex", name: "Codex", available: true },
];

describe("heard: the computer has answered, not merely connected", () => {
  it("is false while any agent asked about has not answered", () => {
    // The socket is open and the agent list is in, but the sessions are not:
    // home said "No sessions yet" here and moved Pew to the middle.
    const pending = ["claude", "codex"];
    let state = reduceMessage(start(), { t: "providers", providers: agents }, scope(pending));
    expect(state.heard).toBe(false);
    pending.shift();
    state = reduceMessage(
      state,
      { t: "provider.capabilities", providerId: "claude", sessions: [] },
      scope(pending),
    );
    expect(state.heard).toBe(false);
  });

  it("turns true with the last answer, and stays true", () => {
    let state = reduceMessage(
      start(),
      { t: "provider.capabilities", providerId: "codex", sessions: [] },
      scope([]),
    );
    expect(state.heard).toBe(true);
    // A reconnect's agent list, with something asked again, does not undo it.
    state = reduceMessage(state, { t: "providers", providers: agents }, scope(["claude"]));
    expect(state.heard).toBe(true);
  });

  it("is true at once when there is no agent to wait on", () => {
    const state = reduceMessage(start(), { t: "providers", providers: [] }, scope([]));
    expect(state.heard).toBe(true);
  });
});

describe("a task started in this chat", () => {
  it("clears the transcript to its note, moves the row to the new agent session and starts work", () => {
    const row = {
      id: "s1",
      providerId: "ggcoder",
      title: "Old chat",
      startedAt: 0,
      turns: [{ id: "s1:1", role: "user" as const, text: "old" }],
      configOptions: [],
      agentSessionId: "gg_1",
      usage: { used: 5, size: 10 },
    };
    const before: State = {
      ...start(),
      sessionId: "s1",
      turns: row.turns,
      sessions: [row],
      usage: row.usage,
    };
    const next = reduceMessage(
      before,
      {
        t: "session.event",
        sessionId: "s1",
        seq: 4,
        payload: {
          kind: "context_reset",
          reason: "task",
          title: "Fix login",
          agentSessionId: "gg_2",
        },
      },
      { ...scope([]), sessionRef: { current: "s1" }, now: 1000 },
    );
    expect(next.turns).toEqual([
      { id: "s1:4", role: "note", text: "Task: Fix login", task: "Fix login" },
    ]);
    expect(next.busy).toBe(true);
    expect(next.activity.startedAt).toBe(1000);
    expect(next.usage).toBeUndefined();
    expect(next.sessions[0]).toMatchObject({
      agentSessionId: "gg_2",
      title: "Fix login",
      busy: true,
      turns: next.turns,
    });
    expect(next.sessions[0]!.usage).toBeUndefined();
  });
});

describe("an accepted plan", () => {
  it("moves the row to the implementation's agent session and keeps the transcript", () => {
    const row = {
      id: "s1",
      providerId: "ggcoder",
      title: "Plan chat",
      startedAt: 0,
      turns: [{ id: "s1:1", role: "user" as const, text: "plan it" }],
      configOptions: [],
      agentSessionId: "gg_1",
    };
    const before: State = { ...start(), sessionId: "s1", turns: row.turns, sessions: [row] };
    const next = reduceMessage(
      before,
      {
        t: "session.event",
        sessionId: "s1",
        seq: 5,
        payload: { kind: "plan_accepted", planTotal: 3, agentSessionId: "gg_1_impl" },
      },
      { ...scope([]), sessionRef: { current: "s1" }, now: 1000 },
    );
    expect(next.turns.map((t) => [t.role, t.text])).toEqual([
      ["user", "plan it"],
      ["note", "Plan accepted · fresh context · 3 steps"],
    ]);
    expect(next.sessions[0]).toMatchObject({ agentSessionId: "gg_1_impl", title: "Plan chat" });
    expect(next.sessions[0]!.turns).toBe(next.turns);
  });
});
