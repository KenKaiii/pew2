import { expect, test } from "bun:test";
import { PromptGate } from "./promptGate";
import { cancelQueued, markCancelled, markSent, partitionOutbox, type OutboxEntry, type QueuedPrompt } from "./outbox";
import type { Turn } from "./useDaemon";
import { pendingSessionKey } from "./pendingSession";

const prompt = (turnKey: string, sessionId = "s1"): QueuedPrompt => ({
  kind: "prompt", turnKey, sessionId, text: turnKey, attachments: [],
});

test("queued follow-ups run one at a time and leave other chats independent", () => {
  const gate = new PromptGate();
  gate.started("s1");
  const queue = [prompt("next"), prompt("last"), prompt("other", "s2")];
  const ready = (entry: OutboxEntry): boolean => entry.kind === "prompt" && gate.canSend(entry.sessionId);
  const during = partitionOutbox(queue, ready);
  expect(during.ready).toEqual([queue[2]]);
  gate.finished("s1");
  const next = partitionOutbox(during.held, ready);
  expect(next.ready).toEqual([queue[0]]);
  gate.started("s1");
  expect(partitionOutbox(next.held, ready).ready).toEqual([]);
  gate.finished("s1");
  expect(partitionOutbox(next.held, ready).ready).toEqual([queue[1]]);
});

test("reconnect waits for current state, including an empty catch-up", () => {
  const gate = new PromptGate();
  gate.reconnect(["s1", "s2"]);
  expect(gate.canSend("s1")).toBe(false);
  gate.catchUp("s1", true, []);
  expect(gate.canSend("s1")).toBe(false);
  gate.catchUp("s2", false, []);
  expect(gate.canSend("s2")).toBe(true);
  gate.finished("s1");
  expect(gate.canSend("s1")).toBe(true);
});

test("a legacy catch-up releases idle queues even when the previous idle was missed", () => {
  for (const wasWorking of [false, true]) {
    const gate = new PromptGate();
    if (wasWorking) gate.started("s1");
    gate.reconnect(["s1"]);
    expect(gate.canSend("s1")).toBe(false);
    gate.catchUp("s1", undefined, undefined);
    const queue = [prompt("next"), prompt("last")];
    const { ready, held } = partitionOutbox(queue, () => gate.canSend("s1"));
    expect(ready).toEqual([queue[0]]);
    expect(held).toEqual([queue[1]]);
  }
});

test("legacy omission does not erase live work observed after reconnect", () => {
  const gate = new PromptGate();
  gate.reconnect(["s1"]);
  gate.started("s1");
  gate.catchUp("s1", undefined, undefined);
  expect(gate.canSend("s1")).toBe(false);
  gate.finished("s1");
  expect(gate.canSend("s1")).toBe(true);
});

test("unanswered approvals remain held when a legacy peer omits their state", () => {
  const gate = new PromptGate();
  gate.catchUp("s1", false, [{ requestId: "permission" }]);
  expect(gate.canSend("s1")).toBe(false);
  gate.reconnect(["s1"]);
  gate.catchUp("s1", undefined, undefined);
  expect(gate.canSend("s1")).toBe(false);
  gate.catchUp("s1", false, []);
  expect(gate.canSend("s1")).toBe(true);
});

test("a live approval survives reconnect until the turn finishes", () => {
  const gate = new PromptGate();
  gate.started("s1");
  gate.waitForPermission("s1");
  gate.reconnect(["s1"]);
  gate.catchUp("s1", undefined, undefined);
  expect(gate.canSend("s1")).toBe(false);
  gate.finished("s1");
  expect(gate.canSend("s1")).toBe(true);
});

test("retired daemon session ids do not keep stale delivery gates", () => {
  const gate = new PromptGate();
  gate.started("old");
  gate.started("live");
  gate.reconnect(["old", "live"]);
  gate.retain(new Set(["live"]));
  expect(gate.canSend("old")).toBe(true);
  expect(gate.canSend("live")).toBe(false);
});

test("cancelling affects only an unsent prompt and preserves its text and images", () => {
  const queue = [prompt("next"), prompt("last")];
  const turn: Turn = {
    id: "next", key: "next", role: "user", text: "Keep this draft", queued: true,
    images: [{ src: "file:///phone/photo.jpg", origin: "device", alt: "Attached photo" }],
  };
  const turns = [turn];
  expect(cancelQueued(queue, "already-sent")).toBe(queue);
  expect(cancelQueued(queue, "next")).toEqual([queue[1]]);
  expect(markCancelled(turns, "next")[0]).toMatchObject({
    text: "Keep this draft", images: turn.images, cancelled: true, queued: false,
  });
  expect(markCancelled(turns, "already-sent")).toBe(turns);
  expect(turns[0]?.queued).toBe(true);
});

test("a pending start cannot be separated from its first prompt by cancellation", () => {
  const queue: OutboxEntry[] = [
    { kind: "start", requestId: "new", providerId: "echo" },
    { ...prompt("first", pendingSessionKey("new")), initialPrompt: true },
  ];
  expect(cancelQueued(queue, "first")).toBe(queue);
});

test("later follow-ups can be cancelled while a new session is still starting", () => {
  const pending = pendingSessionKey("new");
  const first = { ...prompt("first", pending), initialPrompt: true };
  const second = prompt("second", pending);
  const third = prompt("third", pending);
  const start: OutboxEntry = { kind: "start", requestId: "new", providerId: "echo" };
  for (const queue of [[start, first, second, third], [first, second, third]]) {
    expect(cancelQueued(queue, "first")).toBe(queue);
    const remaining = cancelQueued(queue, "second");
    expect(remaining).toEqual(queue.filter((entry) => entry !== second));
    expect(cancelQueued(remaining, "first")).toBe(remaining);
  }
});

test("delivery clears the waiting-for-turn marker so the real echo can adopt it", () => {
  const turn: Turn = { id: "next", key: "next", role: "user", text: "Next", queued: true, queuedForTurn: true };
  const sent = markSent([turn], new Set(["next"]));
  expect(sent[0]?.queued).toBeUndefined();
  expect(sent[0]?.queuedForTurn).toBeUndefined();
});
