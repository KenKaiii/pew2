/**
 * GG Coder's project task list, as the Tasks sheet shows it. Pure and
 * Expo-free so `bun test` can load it.
 */
import type { TaskItem } from "./ggState";

export type TaskBand = TaskItem["status"];

export interface TaskGroup {
  band: TaskBand;
  label: string;
  items: TaskItem[];
}

const BANDS: readonly { band: TaskBand; label: string }[] = [
  { band: "in-progress", label: "In progress" },
  { band: "pending", label: "To do" },
  { band: "done", label: "Done" },
];

/** In progress, then to do, then done; GG Coder's own order within each; empty bands dropped. */
export function groupTasks(items: readonly TaskItem[]): TaskGroup[] {
  return BANDS.map(({ band, label }) => ({
    band,
    label,
    items: items.filter((t) => t.status === band),
  })).filter((g) => g.items.length > 0);
}

/** Why Run can't be tapped now, or undefined when it can; offline wins, as busy is stale without a link. */
export function runBlockedReason(online: boolean, busy: boolean): string | undefined {
  if (!online) return "Reconnect to run this task";
  if (busy) return "Run this once GG Coder stops";
  return undefined;
}

/** What the daemon logs when a task starts in this chat on a fresh agent context. */
export interface ContextReset {
  title: string;
  agentSessionId?: string;
}

/** A logged `context_reset` event, or undefined for anything else. */
export function readContextReset(payload: unknown): ContextReset | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const p = payload as { kind?: unknown; title?: unknown; agentSessionId?: unknown };
  if (p.kind !== "context_reset") return undefined;
  return {
    title: typeof p.title === "string" ? p.title.trim() : "",
    ...(typeof p.agentSessionId === "string" && p.agentSessionId
      ? { agentSessionId: p.agentSessionId }
      : {}),
  };
}

/** The one note a reset transcript starts again from, as GG Coder's "Task:" row. */
export function contextResetText(reset: ContextReset): string {
  return reset.title ? `Task: ${reset.title}` : "Task";
}
