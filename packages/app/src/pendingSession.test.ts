import { expect, test } from "bun:test";
import {
  adoptPendingSession,
  dropPendingSessions,
  isPendingSession,
  pendingSession,
  pendingSessionKey,
} from "./pendingSession";
import type { Session, Turn } from "./useDaemon";

const other: Session = {
  id: "s0",
  providerId: "ggcoder",
  title: "Earlier work",
  startedAt: 1,
  turns: [],
  configOptions: [],
};

const prompt: Turn = { id: "local:1", key: "local:1", role: "user", text: "Fix the bug" };

const live = (id: string): Session => ({
  id,
  providerId: "ggcoder",
  title: "New conversation",
  startedAt: 999,
  turns: [],
  configOptions: [],
});

test("a started conversation is in the list before the daemon has named it", () => {
  const row = pendingSession("r1", "ggcoder", "Fix the bug in the parser", 10);

  expect(isPendingSession(row.id)).toBe(true);
  expect(row.title).toBe("Fix the bug in the parser");
  // The whole point: it is running, and the drawer has to say so from here.
  expect(row.busy).toBe(true);
});

test("a conversation opened with no prompt is not claimed to be working", () => {
  expect(pendingSession("r1", "ggcoder", undefined, 10).busy).toBe(false);
});

test("the answer adopts the row in place rather than adding a second one", () => {
  const waiting = { ...pendingSession("r1", "ggcoder", "Fix the bug", 10), turns: [prompt] };
  const next = adoptPendingSession([other, waiting], "r1", live("sess-9"));

  expect(next).toBeDefined();
  expect(next!.length).toBe(2);
  // Position held, so the row does not move out from under a thumb.
  expect(next![1]!.id).toBe("sess-9");
  expect(next![0]!.id).toBe("s0");
});

test("the optimistic prompt survives adoption", () => {
  const waiting = { ...pendingSession("r1", "ggcoder", "Fix the bug", 10), turns: [prompt] };
  const next = adoptPendingSession([waiting], "r1", live("sess-9"));

  expect(next![0]!.turns).toEqual([prompt]);
  // `session.started` carries no transcript, so the title it computes is the
  // placeholder; the one the user can already read wins.
  expect(next![0]!.title).toBe("Fix the bug");
  expect(next![0]!.startedAt).toBe(10);
});

test("a session another device started does not consume this one's row", () => {
  const waiting = pendingSession("r1", "ggcoder", "Fix the bug", 10);

  expect(adoptPendingSession([waiting], "r2", live("sess-9"))).toBeUndefined();
  expect(adoptPendingSession([waiting], undefined, live("sess-9"))).toBeUndefined();
});

test("requests that can no longer be answered are dropped on reconnect", () => {
  const waiting = pendingSession("r1", "ggcoder", "Fix the bug", 10);

  expect(dropPendingSessions([other, waiting])).toEqual([other]);
  // Same array when there is nothing to drop, so the drawer does not re-render.
  const untouched = [other];
  expect(dropPendingSessions(untouched)).toBe(untouched);
});

test("pending ids are recognisable without being told", () => {
  expect(isPendingSession(pendingSessionKey("r1"))).toBe(true);
  expect(isPendingSession("agent:ggcoder:abc")).toBe(false);
  expect(isPendingSession("sess-9")).toBe(false);
});
