import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession } from "./connect";
import { hydrateGgCoderMessageCounts, loadGgCoderDisplayHistory } from "./ggcoder-history";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("counts the unopened GG Coder lineage exactly as ACP replay renders it", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pew2-gg-history-"));
  roots.push(root);
  const cwd = "/Users/test/my-project";
  const directory = path.join(root, "Users_test_my-project");
  await mkdir(directory, { recursive: true });
  const sessionId = "12345678-1234-1234-1234-123456789abc";
  const entries = [
    { type: "session", id: sessionId, cwd, leafId: "a3" },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Question" } },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      message: { role: "assistant", content: [{ type: "text", text: "Working" }] },
    },
    {
      type: "message",
      id: "tool",
      parentId: "a1",
      message: { role: "tool", content: [{ type: "tool_result", content: "done" }] },
    },
    {
      type: "message",
      id: "a2",
      parentId: "tool",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    },
    {
      type: "message",
      id: "abandoned",
      parentId: "u1",
      message: { role: "assistant", content: "Not on the active branch" },
    },
    { type: "message", id: "u2", parentId: "a2", message: { role: "user", content: "Thanks" } },
    { type: "message", id: "a3", parentId: "u2", message: { role: "assistant", content: "Any time" } },
  ];
  await writeFile(
    path.join(directory, `2026-07-31T12-00-00-000Z_${sessionId.slice(0, 8)}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const sessions: AgentSession[] = [{ sessionId, cwd, title: "Stored session" }];

  await hydrateGgCoderMessageCounts(sessions, root);

  // a1 and a2 coalesce because invisible tool updates do not create a row.
  expect(sessions[0]!.messageCount).toBe(4);
});

test("loads a compacted GG Coder chain locally without the child summary or overlap", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pew2-gg-display-"));
  roots.push(root);
  const cwd = "/Users/test/my-project";
  const directory = path.join(root, "Users_test_my-project");
  await mkdir(directory, { recursive: true });
  const parentId = "aaaaaaaa-1234-1234-1234-123456789abc";
  const childId = "bbbbbbbb-1234-1234-1234-123456789abc";
  const conversationId = parentId;
  const parentMessages = [
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: "First" } },
    { type: "message", id: "a1", parentId: "u1", message: { role: "assistant", content: "Answer" } },
  ];
  await writeFile(
    path.join(directory, `parent_${parentId.slice(0, 8)}.jsonl`),
    [
      { type: "session", id: parentId, conversationId, cwd, leafId: "a1" },
      ...parentMessages,
    ].map((entry) => JSON.stringify(entry)).join("\n"),
  );
  await writeFile(
    path.join(directory, `child_${childId.slice(0, 8)}.jsonl`),
    [
      {
        type: "session",
        id: childId,
        conversationId,
        parentSessionId: parentId,
        cwd,
        leafId: "a2",
      },
      {
        type: "message",
        id: "summary",
        parentId: null,
        message: { role: "user", content: "[Previous conversation summary]\nOld context" },
      },
      { type: "message", id: "u1-copy", parentId: "summary", message: { role: "user", content: "First" } },
      { type: "message", id: "a1-copy", parentId: "u1-copy", message: { role: "assistant", content: "Answer" } },
      { type: "message", id: "u2", parentId: "a1-copy", message: { role: "user", content: "Second" } },
      { type: "message", id: "a2", parentId: "u2", message: { role: "assistant", content: "Done" } },
    ].map((entry) => JSON.stringify(entry)).join("\n"),
  );

  const updates = await loadGgCoderDisplayHistory(childId, cwd, root);
  expect(updates).toEqual([
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "First" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Answer" } },
    { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Second" } },
    { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Done" } },
  ]);
});
