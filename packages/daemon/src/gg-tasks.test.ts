/** GG Coder's task file, read and marked the way GG Coder itself does. */
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { markInProgress, readTasks, runPromptFor, taskFilePath, toTaskRow } from "./gg-tasks.js";

const CWD = "/Users/someone/code/api";

async function plant(tasks: unknown): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "pew2-tasks-"));
  const path = taskFilePath(base, CWD);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, typeof tasks === "string" ? tasks : JSON.stringify(tasks));
  return base;
}

test("the path is GG Coder's: first 16 hex of sha256(cwd)", () => {
  const hash = createHash("sha256").update(CWD).digest("hex").slice(0, 16);
  expect(taskFilePath("/base", CWD)).toBe(join("/base", hash, "tasks.json"));
  expect(hash).toHaveLength(16);
});

test("a missing, corrupt or non-array file is an empty list", async () => {
  const empty = await mkdtemp(join(tmpdir(), "pew2-tasks-"));
  expect(await readTasks(empty, CWD)).toEqual([]);
  expect(await readTasks(await plant("{not json"), CWD)).toEqual([]);
  expect(await readTasks(await plant({ id: "a" }), CWD)).toEqual([]);
});

test("statuses are normalised, legacy {text} tasks migrate, rows without an id drop", async () => {
  const base = await plant([
    { id: "a", title: "Fix login", prompt: "fix the login bug", status: "done" },
    { id: "b", title: "Docs", prompt: "write docs", status: "blocked" },
    { id: "c", text: "old style task", status: "in-progress" },
    { title: "no id" },
    "junk",
  ]);
  expect(await readTasks(base, CWD)).toEqual([
    { id: "a", title: "Fix login", prompt: "fix the login bug", status: "done" },
    { id: "b", title: "Docs", prompt: "write docs", status: "pending" },
    { id: "c", title: "old style task", prompt: "old style task", status: "in-progress" },
  ]);
});

test("only a to-do task gets a run prompt, ending in GG's done hint with the short id", () => {
  const task = {
    id: "12345678-aaaa-bbbb",
    title: "T",
    prompt: "do it",
    status: "pending" as const,
  };
  expect(runPromptFor(task)).toBe(
    'do it\n\n---\nWhen you have fully completed this task, call the tasks tool to mark it done:\ntasks({ action: "done", id: "12345678" })',
  );
  expect(runPromptFor({ ...task, status: "in-progress" })).toBeNull();
  expect(toTaskRow({ ...task, status: "done" }).runPrompt).toBeNull();
});

test("marking touches one row's status and keeps every other field", async () => {
  const stored = [
    { id: "a", title: "A", prompt: "pa", status: "pending", createdAt: "2026-01-01T00:00:00Z" },
    { id: "b", text: "legacy", status: "pending", extra: { keep: true } },
  ];
  const base = await plant(stored);
  await markInProgress(base, CWD, "b");
  const path = taskFilePath(base, CWD);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual([
    stored[0],
    { ...stored[1], status: "in-progress" },
  ]);
  expect((await stat(path)).mode & 0o777).toBe(0o644);
  expect((await readTasks(base, CWD)).map((t) => t.status)).toEqual(["pending", "in-progress"]);
});

test("marking a task that is gone refuses and leaves the file alone", async () => {
  const base = await plant([{ id: "a", title: "A", prompt: "pa", status: "pending" }]);
  const before = await readFile(taskFilePath(base, CWD), "utf8");
  await expect(markInProgress(base, CWD, "zzz")).rejects.toThrow("no longer exists");
  expect(await readFile(taskFilePath(base, CWD), "utf8")).toBe(before);
});
