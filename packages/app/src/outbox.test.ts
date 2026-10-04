import { expect, test } from "bun:test";
import {
  MAX_QUEUED,
  enqueue,
  cancelQueued,
  markSent,
  outboxSession,
  partitionOutbox,
  pendingStartFor,
  queuedPendingSessions,
  remapSession,
  type OutboxEntry,
} from "./outbox";
import type { Turn } from "./useDaemon";

const prompt = (turnKey: string, sessionId: string, text = "hi"): OutboxEntry => ({
  kind: "prompt",
  turnKey,
  sessionId,
  text,
  attachments: [],
});

const start = (requestId: string, providerId = "claude-code"): OutboxEntry => ({
  kind: "start",
  requestId,
  providerId,
});

test("messages keep the order they were typed in", () => {
  let queue: OutboxEntry[] = [];
  queue = enqueue(queue, prompt("a", "s1", "first"))!;
  queue = enqueue(queue, prompt("b", "s1", "second"))!;
  expect(queue.map((entry) => (entry.kind === "prompt" ? entry.text : ""))).toEqual([
    "first",
    "second",
  ]);
});

test("a full queue refuses rather than evicting the oldest message", () => {
  let queue: OutboxEntry[] = [];
  for (let i = 0; i < MAX_QUEUED; i++) queue = enqueue(queue, prompt(`k${i}`, "s1"))!;
  expect(enqueue(queue, prompt("one-too-many", "s1"))).toBeUndefined();
  expect(queue).toHaveLength(MAX_QUEUED);
});

test("attachments past the memory ceiling are refused", () => {
  const heavy = (turnKey: string): OutboxEntry => ({
    kind: "prompt",
    turnKey,
    sessionId: "s1",
    text: "look",
    attachments: [{ name: "photo.jpg", mimeType: "image/jpeg", data: "x".repeat(9 * 1024 * 1024) }],
  });
  let queue: OutboxEntry[] = [];
  queue = enqueue(queue, heavy("a"))!;
  queue = enqueue(queue, heavy("b"))!;
  expect(queue).toHaveLength(2);
  expect(enqueue(queue, heavy("c"))).toBeUndefined();
  // Text still fits: the ceiling is on the bytes, not on the queue.
  expect(enqueue(queue, prompt("c", "s1"))).toBeDefined();
});

test("a start is addressed to the pending row it created", () => {
  expect(outboxSession(start("req-1"))).toBe("pending:req-1");
});

test("a session that gains a real id carries its queued prompts across", () => {
  const queue = [prompt("a", "pending:req-1"), prompt("b", "s2")];
  const next = remapSession(queue, "pending:req-1", "s9");
  expect(next[0]).toMatchObject({ sessionId: "s9" });
  // Another conversation's queue is untouched.
  expect(next[1]).toMatchObject({ sessionId: "s2" });
});

test("re-addressing nothing keeps the same array", () => {
  const queue = [prompt("a", "s1")];
  expect(remapSession(queue, "s2", "s3")).toBe(queue);
});

test("a prompt for a conversation that must be reopened waits instead of failing", () => {
  const queue = [prompt("a", "live"), prompt("b", "dead")];
  const { ready, held } = partitionOutbox(
    queue,
    (entry) => entry.kind !== "prompt" || entry.sessionId === "live",
  );
  expect(ready).toHaveLength(1);
  expect(held).toEqual([queue[1]!]);
});

test("only one prompt per chat is released, without blocking another chat", () => {
  const queue = [prompt("a", "s1"), prompt("b", "s1"), prompt("c", "s2")];
  const { ready, held } = partitionOutbox(queue, () => true);
  expect(ready).toEqual([queue[0]!, queue[2]!]);
  expect(held).toEqual([queue[1]!]);
});

test("a later prompt cannot pass a held prompt in the same chat", () => {
  const queue = [prompt("a", "s1"), prompt("b", "s1")];
  expect(partitionOutbox(queue, (entry) => entry.kind === "prompt" && entry.turnKey === "b").ready).toEqual([]);
});

test("pending rows with something queued are named so the reconnect keeps them", () => {
  const queue = [start("req-1"), prompt("b", "pending:req-1"), prompt("c", "s2")];
  expect(queuedPendingSessions(queue)).toEqual(new Set(["pending:req-1"]));
});

test("a second message joins the conversation already starting on the same agent", () => {
  const queue = [start("req-1", "codex")];
  expect(pendingStartFor(queue, "codex")?.requestId).toBe("req-1");
  // A different agent is a different conversation.
  expect(pendingStartFor(queue, "claude-code")).toBeUndefined();
});

test("the first follow-up can be cancelled while an online session start is in flight", () => {
  // start() has already sent session.start and holds its initial prompt in
  // queued.current. Only follow-ups enter the outbox in this online path.
  const followUp = prompt("follow-up", "pending:online-start");
  const later = prompt("later-follow-up", "pending:online-start");

  for (const queue of [[followUp], [followUp, later]]) {
    const before = [...queue];
    expect(cancelQueued(queue, "follow-up")).toEqual(
      queue.filter((entry) => entry !== followUp),
    );
    expect(queue).toEqual(before);
  }
});

test("offline startup protects its initial prompt but allows later cancellation", () => {
  const request = start("offline-start");
  const initial = { ...prompt("initial", "pending:offline-start"), initialPrompt: true };
  const followUp = prompt("follow-up", "pending:offline-start");
  const queue = [request, initial, followUp];

  expect(cancelQueued(queue, "initial")).toBe(queue);
  expect(cancelQueued(queue, "follow-up")).toEqual([request, initial]);
  expect(queue).toEqual([request, initial, followUp]);
});

test("delivered messages stop saying they are waiting", () => {
  const turns: Turn[] = [
    { id: "local:1", key: "local:1", role: "user", text: "one", queued: true },
    { id: "local:2", key: "local:2", role: "user", text: "two", queued: true },
  ];
  const next = markSent(turns, new Set(["local:1"]));

  expect(next[0]?.queued).toBeUndefined();
  // Still waiting, and untouched down to identity.
  expect(next[1]).toBe(turns[1]!);
});

test("a transcript holding none of them is returned as it was", () => {
  // The identity the flush reads as "this conversation is not the one on
  // screen": a new array here would mark every other thread busy.
  const turns: Turn[] = [{ id: "local:1", key: "local:1", role: "user", text: "one" }];
  expect(markSent(turns, new Set(["local:9"]))).toBe(turns);
  expect(markSent(turns, new Set())).toBe(turns);
});
