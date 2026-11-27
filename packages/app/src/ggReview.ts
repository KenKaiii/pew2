/**
 * GG Coder round-2 extensions — plan review, Autopilot (Ken), project
 * checklist. Pure and Expo-free so `bun test` covers the rules.
 *
 * Plan and autopilot state are per session and live-only: they come from
 * `plan.state` / `autopilot.state` frames or a catch-up's `Replay.plan` /
 * `Replay.autopilot`, never from replayed events (a logged decision is history,
 * and a replay must never open a sheet). Absent = an older daemon said nothing.
 */
import type { wire } from "@pew2/protocol";

export type PendingPlan = NonNullable<wire.PlanState["pending"]>;
export interface PlanInfo {
  planMode: boolean;
  pending: PendingPlan | null;
}
export interface AutopilotInfo {
  enabled: boolean;
  reviewing: boolean;
}
export type ChecklistItem = wire.ChecklistItemRow;

function obj(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

export function readPlan(value: unknown): PlanInfo | undefined {
  const v = obj(value);
  if (!v || typeof v.planMode !== "boolean") return undefined;
  const p = obj(v.pending);
  const pending =
    p &&
    typeof p.planPath === "string" &&
    typeof p.content === "string" &&
    typeof p.generation === "number"
      ? { planPath: p.planPath, content: p.content, generation: p.generation }
      : null;
  return { planMode: v.planMode, pending };
}

export function readAutopilot(value: unknown): AutopilotInfo | undefined {
  const v = obj(value);
  if (!v || typeof v.enabled !== "boolean") return undefined;
  return { enabled: v.enabled, reviewing: v.reviewing === true };
}

/** Clear the pending plan this client just decided (the daemon restates it anyway). */
export function decidedPlan(info: PlanInfo | undefined, generation: number): PlanInfo | undefined {
  if (!info?.pending || info.pending.generation !== generation) return info;
  return { ...info, pending: null };
}

/** A transcript row for a logged GG event; undefined = not one of ours / nothing to show. */
export interface GgEventRow {
  role: "system" | "ken" | "note";
  text: string;
  ken?: { phase: string; round?: number };
}

const AUTOPILOT_PHASES: Record<string, (p: Record<string, unknown>) => string | undefined> = {
  review_start: () => undefined,
  ignored: () => undefined,
  prompted: (p) =>
    typeof p.body === "string" && p.body.trim()
      ? p.body
      : "Not quite done — sending GG Coder back in.",
  done: (p) =>
    typeof p.reason === "string" && p.reason.trim()
      ? `All clear. ${p.reason}`
      : "All clear — that's done.",
  human: (p) =>
    typeof p.reason === "string" && p.reason.trim()
      ? `Over to you: ${p.reason}`
      : "This one needs you.",
  capped: () => "That's enough rounds from me — over to you.",
  plan_accepted: () => "Plan looks good — approved.",
  error: (p) =>
    `Autopilot stopped: ${typeof p.reason === "string" ? p.reason : "something went wrong"}`,
};

export function readGgEvent(payload: unknown): GgEventRow | undefined {
  const p = obj(payload);
  if (!p) return undefined;
  if (p.kind === "plan_decision") {
    if (p.action === "accept") return { role: "note", text: "Plan accepted" };
    if (p.action === "reject") return { role: "note", text: "Plan rejected" };
    if (p.action === "feedback") {
      const fb =
        typeof p.feedback === "string" && p.feedback.trim() ? `: ${p.feedback.trim()}` : "";
      return { role: "note", text: `Plan feedback${fb}` };
    }
    return undefined;
  }
  if (p.kind === "plan_accepted") {
    const n =
      typeof p.planTotal === "number" && p.planTotal > 0
        ? ` · ${p.planTotal} step${p.planTotal === 1 ? "" : "s"}`
        : "";
    return { role: "note", text: `Plan accepted · fresh context${n}` };
  }
  if (p.kind === "autopilot" && typeof p.phase === "string") {
    const text = AUTOPILOT_PHASES[p.phase]?.(p);
    if (!text) return undefined;
    const ken =
      typeof p.round === "number" ? { phase: p.phase, round: p.round } : { phase: p.phase };
    return { role: "ken", text, ken };
  }
  return undefined;
}

/** The agent session a logged `plan_accepted` moved the chat to; undefined from an older daemon. */
export function readPlanAcceptedSession(payload: unknown): string | undefined {
  const p = obj(payload);
  if (p?.kind !== "plan_accepted") return undefined;
  return typeof p.agentSessionId === "string" && p.agentSessionId ? p.agentSessionId : undefined;
}

// ── Checklist ───────────────────────────────────────────────

export const CHECKLIST_STATUS_LABEL: Record<ChecklistItem["status"], string> = {
  passed: "passed",
  "needs-work": "needs work",
  due: "due",
  "not-run": "not run",
  "not-applicable": "n/a",
};

const STATUS_ORDER: Record<ChecklistItem["status"], number> = {
  "needs-work": 0,
  due: 1,
  "not-run": 2,
  passed: 3,
  "not-applicable": 4,
};

export interface ChecklistGroup {
  group: string;
  items: ChecklistItem[];
}

/** Groups in first-seen order; within a group, attention first, then title. */
export function groupChecklist(items: readonly ChecklistItem[]): ChecklistGroup[] {
  const groups: ChecklistGroup[] = [];
  for (const item of items) {
    let g = groups.find((entry) => entry.group === item.group);
    if (!g) {
      g = { group: item.group, items: [] };
      groups.push(g);
    }
    g.items.push(item);
  }
  for (const g of groups) {
    g.items.sort(
      (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.title.localeCompare(b.title),
    );
  }
  return groups;
}

/** What Run sends: the setup item runs `/init` (as the desktop does), others their own prompt. */
export function checklistRunPrompt(item: Pick<ChecklistItem, "id" | "runPrompt">): string | null {
  return item.id === "agent-setup" ? "/init" : item.runPrompt;
}
