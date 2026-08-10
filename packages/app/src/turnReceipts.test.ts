import { expect, test } from "bun:test";
import type { TurnReceipt } from "./activity";
import { receiptOnOpen, receiptOnReplay, recordReceipt } from "./turnReceipts";
import type { Session } from "./useDaemon";

const answered: TurnReceipt = { verb: "Answered", duration: "3s", tools: 0, failed: 0 };
const edited: TurnReceipt = { verb: "Edited & ran", duration: "12s", tools: 4, failed: 0 };

const session = (over: Partial<Session> = {}): Session => ({
  id: "s1",
  providerId: "ggcoder",
  title: "Fix the bug",
  startedAt: 1,
  turns: [],
  configOptions: [],
  ...over,
});

test("a finished turn's summary is kept on the conversation that produced it", () => {
  const next = recordReceipt([session()], "s1", answered);

  // The bug this exists for: the summary was screen state only, so it survived
  // exactly until the user opened another conversation.
  expect(next[0]!.receipt).toEqual(answered);
});

test("reopening a settled conversation shows the same line again", () => {
  const stored = recordReceipt([session()], "s1", answered)[0]!;

  expect(receiptOnOpen(stored)).toEqual(answered);
});

test("a newer turn replaces the summary of the one before it", () => {
  const first = recordReceipt([session()], "s1", answered);
  const second = recordReceipt(first, "s1", edited);

  expect(second[0]!.receipt).toEqual(edited);
});

test("a background turn keeps the last summary this device actually measured", () => {
  const watched = recordReceipt([session()], "s1", answered);
  // Undefined is what the reducer passes for a conversation that finished while
  // the user was elsewhere: its tools were never rendered, so there is no live
  // activity to summarise and a fabricated one would be a guess.
  const background = recordReceipt(watched, "s1", undefined);

  expect(background[0]!.receipt).toEqual(answered);
});

test("a conversation still working shows no summary, since none is measured yet", () => {
  const running = recordReceipt([session({ busy: true })], "s1", answered)[0]!;

  // The stored line belongs to a finished turn; showing it under a running one
  // would date-stamp the wrong reply.
  expect(receiptOnOpen(running)).toBeUndefined();
  // Still kept, so it comes back when this turn ends.
  expect(running.receipt).toEqual(answered);
});

test("a resumed conversation gets its summary back with its transcript", () => {
  // Resuming marks the session working on the way in, so the flag says nothing
  // about whether a turn is being timed; only `running` does.
  const sessions = recordReceipt([session({ busy: true })], "s1", answered);

  expect(receiptOnReplay(sessions, "s1", false)).toEqual(answered);
});

test("a replay that lands mid-turn names no finished turn", () => {
  const sessions = recordReceipt([session()], "s1", answered);

  // The live activity line is what belongs under a running turn; a summary here
  // would date-stamp a reply that has not been given yet.
  expect(receiptOnReplay(sessions, "s1", true)).toBeUndefined();
});

test("a replay never borrows the summary of another conversation", () => {
  const sessions = recordReceipt([session()], "s1", answered);

  // The reason the old code cleared on replay: screen state belongs to the
  // thread being left. Reading from the session makes that impossible.
  expect(receiptOnReplay(sessions, "s2", false)).toBeUndefined();
  expect(receiptOnReplay(sessions, undefined, false)).toBeUndefined();
});

test("a summary for a conversation the drawer does not hold changes nothing", () => {
  const before = [session()];

  expect(recordReceipt(before, "gone", answered)).toBe(before);
  expect(recordReceipt(before, undefined, answered)).toBe(before);
});
