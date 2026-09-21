import { expect, test } from "bun:test";
import { createStreamBatch, foldStreamBatch, MAX_BUFFER_BYTES, MAX_BUFFER_EVENTS } from "./streamBatch";
import type { StreamChunk } from "./streamBatch";
import { IDLE_ACTIVITY } from "./activity";
import { applyChunk } from "./replayFold";
import type { Session, Turn } from "./useDaemon";
import type { LiveStreamIdentity } from "./smoothText";

function event(text: string, seq = 1, sessionId = "a", role: "agent" | "thought" = "agent"): StreamChunk {
  return { sessionId, id: `${sessionId}:${seq}`, chunk: { role, text }, now: seq, payload: { update: { sessionUpdate: role === "agent" ? "agent_message_chunk" : "agent_thought_chunk", content: { type: "text", text } } } };
}
function harness() {
  const commits: (readonly StreamChunk[])[] = [];
  const timers = new Map<number, () => void>();
  let id = 0;
  const batch = createStreamBatch((events) => commits.push(events), (cb, ms) => {
    expect(ms).toBe(100);
    timers.set(++id, cb);
    return id;
  }, (key) => { timers.delete(key); });
  return { batch, commits, timers, tick() { for (const cb of [...timers.values()]) cb(); } };
}

test("first chunk immediate; subsequent chunks keep their identities and order", () => {
  const h = harness();
  h.batch.push(event("First."));
  expect(h.commits.length).toBe(1);
  h.batch.push(event("Second", 2));
  h.batch.push(event(" word", 3));
  expect(h.commits.length).toBe(1);
  expect(h.timers.size).toBe(1);
  h.tick();
  expect(h.commits[1]!.map((e) => e.id)).toEqual(["a:2", "a:3"]);
  expect(h.timers.size).toBe(0);
});

test.each(["permission", "tool", "cancel", "error", "replay", "navigation", "disconnect", "background"])("%s boundary commits tail before transition and resets first chunk", () => {
  const h = harness();
  h.batch.push(event("a"));
  h.batch.push(event("b", 2));
  h.batch.boundary();
  expect(h.commits.flat().map((e) => e.chunk.text).join("")).toBe("ab");
  expect(h.timers.size).toBe(0);
  h.batch.push(event("c", 3));
  expect(h.commits.length).toBe(3);
});

test("session and role changes flush without mixing owners", () => {
  const h = harness();
  h.batch.push(event("a"));
  h.batch.push(event("b", 2));
  h.batch.push(event("thought", 3, "a", "thought"));
  h.batch.push(event("other", 1, "b"));
  expect(h.commits.map((es) => es.map((e) => e.chunk.text))).toEqual([["a"], ["b"], ["thought"], ["other"]]);
});

test("event/UTF-8 bounds and oversized bypass never reorder or discard", () => {
  const h = harness();
  h.batch.push(event("first"));
  for (let n = 0; n <= MAX_BUFFER_EVENTS; n++) h.batch.push(event("x", n + 2));
  expect(h.commits[1]!.length).toBe(MAX_BUFFER_EVENTS);
  const huge = "世".repeat(MAX_BUFFER_BYTES / 3 + 1);
  h.batch.push(event(huge, 200));
  expect(h.commits.at(-1)![0]!.chunk.text).toBe(huge);
  expect(h.commits.at(-2)!.length).toBe(1);
  expect(h.timers.size).toBe(0);
});

test("byte boundary flushes before exceeding limit", () => {
  const h = harness();
  h.batch.push(event("first"));
  h.batch.push(event("x".repeat(MAX_BUFFER_BYTES), 2));
  h.batch.push(event("y", 3));
  expect(h.commits[1]![0]!.chunk.text.length).toBe(MAX_BUFFER_BYTES);
  h.batch.boundary();
  expect(h.commits[2]![0]!.chunk.text).toBe("y");
});

test("dispose commits accepted content once; stale timer and future pushes cannot update", () => {
  const h = harness();
  h.batch.push(event("a"));
  h.batch.push(event("b", 2));
  const stale = [...h.timers.values()][0]!;
  h.batch.dispose();
  stale();
  h.batch.push(event("c", 3));
  h.batch.dispose();
  expect(h.commits.flat().length).toBe(2);
  expect(h.timers.size).toBe(0);
});

function state(sessionId = "a") {
  const row: Session = { id: "a", providerId: "gg", title: "New conversation", startedAt: 1, turns: [], configOptions: [] };
  return { sessionId, turns: [] as Turn[], sessions: [row], activity: IDLE_ACTIVITY, busy: false, activeStream: undefined as LiveStreamIdentity | undefined };
}
test("fold preserves chunk seams, latest state and updater replay without mutation", () => {
  const original = state();
  const chunks = [event("First."), event("Second", 2), event(" word", 3)];
  const expected: Turn[] = [];
  for (const e of chunks) applyChunk(expected, e.id, e.chunk);
  const next = foldStreamBatch(original, chunks);
  expect(next.turns).toEqual(expected);
  expect(next.turns[0]!.text).toBe("First.\n\nSecond word");
  expect(foldStreamBatch(original, chunks)).toEqual(next);
  expect(original.turns).toEqual([]);
  expect(original.sessions[0]!.turns).toEqual([]);
  expect(next.sessions[0]!.turns).toBe(next.turns);
  const latest = foldStreamBatch(next, [event(" tail", 4)]);
  expect(latest.turns[0]!.text.endsWith(" tail")).toBe(true);
});
test("live identity follows stable turn, resets generation, excludes thoughts", () => {
  const first = foldStreamBatch(state(), [event("hello")], 1);
  const growth = foldStreamBatch(first, [event(" world", 2)], 1);
  expect(growth.activeStream).toEqual(first.activeStream);
  const replayReset = foldStreamBatch(growth, [event(" tail", 3)], 2);
  expect(replayReset.activeStream?.generation).toBe(2);
  const thought = foldStreamBatch(replayReset, [event("thinking", 4, "a", "thought")], 2);
  expect(thought.activeStream).toBeUndefined();
});
test("flushing after navigation updates owner cache only", () => {
  const other = state("b");
  const next = foldStreamBatch(other, [event("owner's text")]);
  expect(next.turns).toBe(other.turns);
  expect(next.busy).toBe(false);
  expect(next.activity).toBe(other.activity);
  expect(next.sessions[0]!.turns[0]!.text).toBe("owner's text");
});
