import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AgentSession } from "./connect";
import { hydrateClaudeMessageCounts, loadClaudeDisplayHistory } from "./claude-history";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("counts only rows the official Claude ACP replay renders", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pew2-claude-history-"));
  roots.push(root);
  const cwd = "/Users/test/my-project";
  const directory = path.join(root, "-Users-test-my-project");
  await mkdir(directory, { recursive: true });
  const sessionId = "12345678-1234-1234-1234-123456789abc";
  const entries = [
    { type: "user", message: { role: "user", content: "Question" } },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Working" }] },
    },
    {
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: "done" }] },
    },
    {
      type: "user",
      isMeta: true,
      message: { role: "user", content: "Base directory for this skill" },
    },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: "<local-command-stdout>synthetic output</local-command-stdout>",
      },
    },
    { type: "user", message: { role: "user", content: "Thanks" } },
    {
      type: "assistant",
      message: { role: "assistant", content: "Please run /login · API Error" },
    },
    { type: "assistant", message: { role: "assistant", content: "Any time" } },
  ];
  await writeFile(
    path.join(directory, `${sessionId}.jsonl`),
    `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
  );
  const sessions: AgentSession[] = [{ sessionId, cwd, title: "Stored session" }];

  await hydrateClaudeMessageCounts(sessions, root);
  const display = await loadClaudeDisplayHistory(sessionId, cwd, root);

  // Working + Done coalesce around invisible tool/meta events; synthetic login is skipped.
  expect(sessions[0]!.messageCount).toBe(4);
  expect(display?.map(({ role, text }) => `${role}:${text}`)).toEqual([
    "user:Question",
    "assistant:Working",
    "assistant:Done",
    "user:Thanks",
    "assistant:Any time",
  ]);
});
