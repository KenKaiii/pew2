import { test, expect } from "bun:test";
import { SessionLog } from "./log.js";

test("events come back in order with gapless sequence numbers", () => {
  const log = new SessionLog("s");
  log.append({ a: 1 });
  log.append({ a: 2 });

  expect(log.events.map((e) => e.seq)).toEqual([0, 1]);
  expect(log.latestSeq).toBe(1);
});

test("a reconnecting client gets only what it has not seen", () => {
  const log = new SessionLog("s");
  for (let i = 0; i < 5; i++) log.append({ i });

  expect(log.since(2).map((e) => e.seq)).toEqual([3, 4]);
  expect(log.since(-1)).toHaveLength(5);
  expect(log.since(4)).toEqual([]);
});

test("a long conversation does not grow without limit", () => {
  // A streamed reply arrives as hundreds of small chunks, and sessions live as
  // long as the daemon. Unbounded, 20,000 chunks measured 3.8MB per session and
  // was never freed.
  const log = new SessionLog("s");
  for (let i = 0; i < 30_000; i++) log.append({ i });

  expect(log.events.length).toBeLessThanOrEqual(11_000);
  // The newest are the ones kept: those are what a reconnect needs.
  expect(log.events.at(-1)!.seq).toBe(29_999);
});

test("sequence numbers keep counting after old events are dropped", () => {
  // `seq` is the client's cursor. If it reset when the window slid, a client
  // would be sent events it already had, or skip past ones it had not.
  const log = new SessionLog("s");
  for (let i = 0; i < 12_000; i++) log.append({ i });

  const seqs = log.events.map((e) => e.seq);
  expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  expect(new Set(seqs).size).toBe(seqs.length);
  expect(log.latestSeq).toBe(11_999);
});

test("a cursor older than the window returns what is still held", () => {
  // The phone was off for a very long conversation. It gets everything the
  // daemon still has rather than nothing, and reopening replays the rest.
  const log = new SessionLog("s");
  for (let i = 0; i < 15_000; i++) log.append({ i });

  const caught = log.since(5);
  expect(caught.length).toBe(log.events.length);
  expect(caught[0]!.seq).toBeGreaterThan(5);
});
