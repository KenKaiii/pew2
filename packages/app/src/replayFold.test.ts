import { expect, test } from "bun:test";
import { foldSessionEvents, isOptimistic } from "./replayFold";
import type { PermissionRequest, Session, Turn } from "./useDaemon";

const user = (seq: number, text: string) => ({
  sessionId: "s1",
  seq,
  payload: { update: { sessionUpdate: "user_message_chunk", content: { text } } },
});
const agent = (seq: number, text: string) => ({
  sessionId: "s1",
  seq,
  payload: { update: { sessionUpdate: "agent_message_chunk", content: { text } } },
});

const state = (turns: Turn[] = [], sessions: Session[] = []) => ({
  turns,
  sessions,
  busy: true,
  permission: undefined as PermissionRequest | undefined,
});

const sessionStub: Session = {
  id: "s1",
  providerId: "ggcoder",
  title: "New conversation",
  startedAt: 1,
  turns: [],
  configOptions: [],
};

test("a batch of chunks lands as coalesced turns in one state", () => {
  const next = foldSessionEvents(
    state([], [sessionStub]),
    [user(0, "Fix the bug"), agent(1, "Looking "), agent(2, "into it"), agent(3, " now")],
  );

  expect(next.turns).toEqual([
    { id: "s1:0", role: "user", text: "Fix the bug" },
    { id: "s1:1", role: "agent", text: "Looking into it now" },
  ]);
  expect(next.busy).toBe(true);
});

test("the session mirror gains the turns and a title from the first user message", () => {
  const next = foldSessionEvents(state([], [sessionStub]), [user(0, "Refactor auth"), agent(1, "On it")]);

  expect(next.sessions[0]?.title).toBe("Refactor auth");
  expect(next.sessions[0]?.turns).toHaveLength(2);
});

test("an optimistic prompt is adopted, not duplicated", () => {
  const optimisticTurn: Turn = { id: "local:0", role: "user", text: "Hello" };
  const next = foldSessionEvents(state([optimisticTurn], [sessionStub]), [user(0, "Hello")]);

  expect(next.turns).toHaveLength(1);
  expect(next.turns[0]?.id).toBe("s1:0");
  expect(isOptimistic(next.turns[0]!)).toBe(false);
});

test("a permission request inside the batch surfaces", () => {
  const next = foldSessionEvents(state([], []), [
    {
      sessionId: "s1",
      seq: 0,
      payload: { kind: "permission_request", requestId: "p1", params: { toolCall: { title: "Run bash?" } } },
    },
  ]);

  expect(next.permission?.requestId).toBe("p1");
  expect(next.permission?.title).toBe("Run bash?");
  expect(next.busy).toBe(false);
});

test("an empty batch returns the same state", () => {
  const prev = state([], []);
  expect(foldSessionEvents(prev, [])).toBe(prev);
});

test("other sessions in the list are untouched", () => {
  const other: Session = { ...sessionStub, id: "s2", title: "Kept" };
  const next = foldSessionEvents(state([], [sessionStub, other]), [user(0, "Hi")]);

  expect(next.sessions[1]).toBe(other);
});
