import { expect, test } from "bun:test";
import {
  adoptPendingSession,
  dropPendingSessions,
  isPendingSession,
  pendingSession,
  pendingSessionKey,
} from "./pendingSession";
import { sessionInProject } from "./projects";
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

test("a request still queued offline survives the reconnect that will send it", () => {
  const waiting = pendingSession("r1", "ggcoder", "Fix the bug", 10);
  const keep = new Set([pendingSessionKey("r1")]);

  expect(dropPendingSessions([other, waiting], keep)).toEqual([other, waiting]);
  // A request that did reach the dead socket still goes: its answer was
  // broadcast once, into nothing.
  const abandoned = pendingSession("r2", "ggcoder", "Something else", 11);
  expect(dropPendingSessions([waiting, abandoned], keep)).toEqual([waiting]);
});

test("pending ids are recognisable without being told", () => {
  expect(isPendingSession(pendingSessionKey("r1"))).toBe(true);
  expect(isPendingSession("agent:ggcoder:abc")).toBe(false);
  expect(isPendingSession("sess-9")).toBe(false);
});

test("a new conversation is visible under the project it was started in", () => {
  const row = pendingSession("r1", "ggcoder", "Fix the bug", 10, "/Users/me/work/api");

  // Without this the drawer drops the row entirely whenever a project is
  // selected: `sessionInProject` matches on `cwd`, and a session with none
  // matches nothing. The row existed and still could not be found.
  expect(sessionInProject(row, { name: "api", path: "/Users/me/work/api" })).toBe(true);
});

test("the project survives adoption, so the row does not vanish when it is named", () => {
  const waiting = pendingSession("r1", "ggcoder", "Fix the bug", 10, "/Users/me/work/api");
  const next = adoptPendingSession([waiting], "r1", live("sess-9"));

  expect(next![0]!.cwd).toBe("/Users/me/work/api");
});

test("a project the daemon resolved wins over the one that was asked for", () => {
  const waiting = pendingSession("r1", "ggcoder", "Fix the bug", 10, "/Users/me/guess");
  const resolved = { ...live("sess-9"), cwd: "/Users/me/work/api" };
  const next = adoptPendingSession([waiting], "r1", resolved);

  // An unrecognised path falls back to the agent's last workspace on the
  // daemon, so the answer knows where the work really started and the request
  // only knows where it was aimed.
  expect(next![0]!.cwd).toBe("/Users/me/work/api");
});
