/**
 * GG Coder's per-project task list, read straight from its file.
 *
 * GG Coder has no ACP call for tasks, so this mirrors `core/tasks-store.js`:
 * `<base>/<sha256(cwd) hex, first 16>/tasks.json`, a JSON array. Everything
 * that knows that private layout lives here, so a change to it empties the
 * phone's list rather than breaking anything else.
 */
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { wire } from "@pew2/protocol";
import { writeFileAtomic } from "./atomic-file.js";

type Status = wire.TaskRow["status"];
type Task = { id: string; title: string; prompt: string; status: Status };

const STATUSES = new Set<string>(["pending", "in-progress", "done"]);

/** GG Coder hashes the exact cwd string it was given; a symlinked spelling is another project. */
export function taskFilePath(base: string, cwd: string): string {
  const hash = createHash("sha256").update(cwd).digest("hex").slice(0, 16);
  return join(base, hash, "tasks.json");
}

async function readRaw(base: string, cwd: string): Promise<unknown[]> {
  try {
    const parsed: unknown = JSON.parse(await readFile(taskFilePath(base, cwd), "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

/** One stored task, with GG's legacy `{ text }` shape migrated as `migrateTask` does. */
function readTask(value: unknown): Task | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !raw.id) return undefined;
  const title = text(raw.title) || text(raw.text);
  const prompt = text(raw.prompt) || text(raw.text) || title;
  const status =
    typeof raw.status === "string" && STATUSES.has(raw.status) ? raw.status : "pending";
  return { id: raw.id, title, prompt, status: status as Status };
}

/** The project's tasks in file order; a missing or unreadable file is an empty list. */
export async function readTasks(base: string, cwd: string): Promise<Task[]> {
  return (await readRaw(base, cwd)).flatMap((value) => {
    const task = readTask(value);
    return task ? [task] : [];
  });
}

/** What GG Coder's own runner sends, so the agent ticks the task off when it is done. */
export function runPromptFor(task: Task): string | null {
  if (task.status !== "pending") return null;
  return (
    `${task.prompt}\n\n---\nWhen you have fully completed this task, call the tasks tool to mark it done:\n` +
    `tasks({ action: "done", id: "${task.id.slice(0, 8)}" })`
  );
}

export function toTaskRow(task: Task): wire.TaskRow {
  return { ...task, runPrompt: runPromptFor(task) };
}

/**
 * Mark one task in progress, as GG Coder's runner does before it starts one.
 *
 * Re-reads the file and changes only that row's `status`, keeping every other
 * field GG Coder stored, so a write from GG Coder since the list was shown is
 * not undone.
 */
export async function markInProgress(base: string, cwd: string, id: string): Promise<void> {
  const raw = await readRaw(base, cwd);
  let found = false;
  const updated = raw.map((value) => {
    if (!value || typeof value !== "object" || (value as { id?: unknown }).id !== id) return value;
    found = true;
    return { ...value, status: "in-progress" };
  });
  if (!found) throw new Error("That task no longer exists.");
  await writeFileAtomic(taskFilePath(base, cwd), JSON.stringify(updated, null, 2) + "\n", 0o644);
}
