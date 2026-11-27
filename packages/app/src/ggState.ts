/**
 * Live state for GG Coder's extensions — queued messages, open `ask_user`
 * questions, goals — folded from daemon frames. Expo-free and pure so the
 * rules are tested; `useDaemon` holds one of these beside its main state.
 *
 * Every field is per session and keyed by daemon session id, so it survives
 * switching conversations the same way a session row's `permission` does.
 * Every daemon field may be absent (older daemon): absent means say nothing.
 */
import type { wire } from "@pew2/protocol";
import { readAskEvent, readAskList, type AskRequest } from "./askUser";
import type { QueuedMessage } from "./queue";
import {
  readAutopilot,
  readPlan,
  type AutopilotInfo,
  type ChecklistItem,
  type PlanInfo,
} from "./ggReview";

export type GoalSummary = wire.GoalSummary;
export type GoalState = wire.GoalState;
export type GoalWorker = wire.GoalWorker;
export type GoalResult = wire.GoalResult;
export type TaskItem = wire.TaskRow;

export interface ReturnedMessages {
  sessionId: string;
  messages: QueuedMessage[];
  /** Bumped per hand-back so the same texts returned twice still apply. */
  nonce: number;
}

export interface GgState {
  queues: Record<string, QueuedMessage[]>;
  /** Open questions per session, oldest first. */
  asks: Record<string, AskRequest[]>;
  /** Undefined until the daemon has answered a `goals` request. */
  goals?: GoalSummary[];
  goalsError?: string;
  goalsLoading: boolean;
  goalStates: Record<string, GoalState>;
  goalResults: Record<string, GoalResult>;
  returned?: ReturnedMessages;
  plans: Record<string, PlanInfo>;
  autopilot: Record<string, AutopilotInfo>;
  /** Last checklist answer per session; `changed` nudges bump `checklistNonce`. */
  checklists: Record<string, { items?: ChecklistItem[]; error?: string; staleAfterDays?: number }>;
  checklistNonce: number;
  /** Last task-list answer per session; a finished turn bumps `tasksNonce` so an open sheet re-asks. */
  tasks: Record<string, { items?: TaskItem[]; error?: string; requestId?: string }>;
  tasksNonce: number;
  /** GG extensions per provider id, from `provider.capabilities` (absent = none). */
  extensions: Record<string, wire.ProviderExtensions>;
}

export const EMPTY_GG: GgState = {
  queues: {},
  asks: {},
  goalsLoading: false,
  goalStates: {},
  goalResults: {},
  plans: {},
  autopilot: {},
  checklists: {},
  checklistNonce: 0,
  tasks: {},
  tasksNonce: 0,
  extensions: {},
};

function isQueued(value: unknown): value is QueuedMessage {
  if (typeof value !== "object" || value === null) return false;
  const m = value as Record<string, unknown>;
  return typeof m.id === "string" && typeof m.text === "string";
}

function readQueue(value: unknown): QueuedMessage[] | undefined {
  return Array.isArray(value) ? value.filter(isQueued) : undefined;
}

function withKey<T>(
  record: Record<string, T>,
  key: string,
  value: T | undefined,
): Record<string, T> {
  if (value === undefined) {
    if (!(key in record)) return record;
    const next = { ...record };
    delete next[key];
    return next;
  }
  return { ...record, [key]: value };
}

function isGoalState(value: unknown): value is GoalState {
  if (typeof value !== "object" || value === null) return false;
  const g = value as Record<string, unknown>;
  return (
    typeof g.sessionId === "string" &&
    typeof g.goalId === "string" &&
    typeof g.phase === "string" &&
    typeof g.paused === "boolean" &&
    Array.isArray(g.workers)
  );
}

/** A `session.queue` frame: replace the list; note anything handed back. */
export function applyQueue(
  state: GgState,
  message: { sessionId: string; queued?: unknown; returned?: unknown },
): GgState {
  const queued = readQueue(message.queued) ?? [];
  const returned = readQueue(message.returned);
  return {
    ...state,
    queues: withKey(state.queues, message.sessionId, queued.length > 0 ? queued : undefined),
    returned:
      returned && returned.length > 0
        ? {
            sessionId: message.sessionId,
            messages: returned,
            nonce: (state.returned?.nonce ?? 0) + 1,
          }
        : state.returned,
  };
}

/**
 * The live-state extras on a `session.replay` frame. Never reads `events`:
 * a logged question is history, and a replay must never open a card.
 */
export function applyReplayExtras(
  state: GgState,
  message: {
    sessionId: string;
    queued?: unknown;
    asks?: unknown;
    goal?: unknown;
    plan?: unknown;
    autopilot?: unknown;
  },
): GgState {
  let next = state;
  const queued = readQueue(message.queued);
  if (queued)
    next = {
      ...next,
      queues: withKey(next.queues, message.sessionId, queued.length > 0 ? queued : undefined),
    };
  const asks = readAskList(message.asks);
  if (asks)
    next = {
      ...next,
      asks: withKey(next.asks, message.sessionId, asks.length > 0 ? asks : undefined),
    };
  if (isGoalState(message.goal)) {
    next = { ...next, goalStates: { ...next.goalStates, [message.sessionId]: message.goal } };
  }
  const plan = readPlan(message.plan);
  if (plan) next = { ...next, plans: { ...next.plans, [message.sessionId]: plan } };
  const autopilot = readAutopilot(message.autopilot);
  if (autopilot)
    next = { ...next, autopilot: { ...next.autopilot, [message.sessionId]: autopilot } };
  return next;
}

/**
 * A *live* `session.event` (already past the cursor). Opens a card for
 * `ask_user`; `ask_user_closed` (answered on any device, withdrawn by the
 * agent, or its connection gone) closes it.
 */
export function applyLiveEvent(state: GgState, sessionId: string, payload: unknown): GgState {
  if (
    typeof payload === "object" &&
    payload !== null &&
    (payload as { kind?: unknown }).kind === "ask_user_closed" &&
    typeof (payload as { requestId?: unknown }).requestId === "string"
  ) {
    return closeAsk(state, sessionId, (payload as { requestId: string }).requestId);
  }
  const ask = readAskEvent(payload);
  if (!ask) return state;
  const open = state.asks[sessionId] ?? [];
  if (open.some((entry) => entry.requestId === ask.requestId)) return state;
  return { ...state, asks: { ...state.asks, [sessionId]: [...open, ask] } };
}

/** This client answered or dismissed a question. */
export function closeAsk(state: GgState, sessionId: string, requestId: string): GgState {
  const open = state.asks[sessionId];
  if (!open) return state;
  const rest = open.filter((entry) => entry.requestId !== requestId);
  if (rest.length === open.length) return state;
  return { ...state, asks: withKey(state.asks, sessionId, rest.length > 0 ? rest : undefined) };
}

/** Withdraw a queued message optimistically; the daemon's next list is the truth. */
export function dropQueued(state: GgState, sessionId: string, id: string): GgState {
  const list = state.queues[sessionId];
  if (!list) return state;
  const rest = list.filter((entry) => entry.id !== id);
  return { ...state, queues: withKey(state.queues, sessionId, rest.length > 0 ? rest : undefined) };
}

/** `goals`, `goal.result` and `goal.state` frames. */
export function applyGoalMessage(
  state: GgState,
  message: { t: string } & Record<string, unknown>,
): GgState {
  if (message.t === "goals") {
    if (typeof message.error === "string")
      return { ...state, goalsLoading: false, goalsError: message.error };
    if (!Array.isArray(message.goals)) return { ...state, goalsLoading: false };
    return {
      ...state,
      goals: message.goals as GoalSummary[],
      goalsLoading: false,
      goalsError: undefined,
    };
  }
  if (message.t === "goal.result" && typeof message.requestId === "string") {
    return {
      ...state,
      goalResults: { ...state.goalResults, [message.requestId]: message as unknown as GoalResult },
    };
  }
  if (message.t === "goal.state" && isGoalState(message)) {
    return { ...state, goalStates: { ...state.goalStates, [message.sessionId]: message } };
  }
  return state;
}

/** The goal a session belongs to, by live session id or by its folder. */
export function goalForSession(
  goals: readonly GoalSummary[] | undefined,
  session: { sessionId?: string; cwd?: string; agentSessionId?: string },
  state?: GoalState,
): GoalSummary | undefined {
  if (!goals) return undefined;
  return goals.find(
    (goal) =>
      (state !== undefined && goal.id === state.goalId) ||
      (session.sessionId !== undefined && goal.sessionId === session.sessionId) ||
      (session.agentSessionId !== undefined && goal.agentSessionId === session.agentSessionId) ||
      (session.cwd !== undefined && goal.path === session.cwd),
  );
}

export const GOAL_STATUS_LABEL: Record<wire.GoalStatus, string> = {
  briefing: "Briefing",
  running: "Running",
  paused: "Paused",
  interrupted: "Interrupted",
  idle: "Idle",
};

/** "just now", "5m ago", "3h ago", "2d ago". `now` injected for tests. */
export function lastActiveLabel(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/** Newest activity first; ties by name for a stable order. */
export function sortGoals(goals: readonly GoalSummary[]): GoalSummary[] {
  return [...goals].sort((a, b) => b.lastActiveMs - a.lastActiveMs || a.name.localeCompare(b.name));
}

/** "1m 05s" for a worker's elapsed time. */
export function elapsedLabel(ms: number | undefined): string {
  if (ms === undefined || ms < 0) return "";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** A worker's elapsed time now: live ones count from `startedAt`. */
export function workerElapsed(worker: GoalWorker, now: number): number | undefined {
  const live = worker.state === "starting" || worker.state === "running";
  if (live && worker.startedAt !== undefined) return Math.max(0, now - worker.startedAt);
  return worker.elapsedMs;
}

/** `plan.state` / `autopilot.state` / `checklist` frames. */
export function applyReviewMessage(
  state: GgState,
  message: { t: string } & Record<string, unknown>,
): GgState {
  if (message.t === "provider.capabilities") {
    const ext = message.extensions;
    const id = message.providerId;
    if (typeof id !== "string" || typeof ext !== "object" || ext === null) return state;
    return { ...state, extensions: { ...state.extensions, [id]: ext as wire.ProviderExtensions } };
  }
  const sessionId = message.sessionId;
  if (typeof sessionId !== "string") return state;
  if (message.t === "plan.state") {
    const plan = readPlan(message);
    return plan ? { ...state, plans: { ...state.plans, [sessionId]: plan } } : state;
  }
  if (message.t === "autopilot.state") {
    const a = readAutopilot(message);
    return a ? { ...state, autopilot: { ...state.autopilot, [sessionId]: a } } : state;
  }
  if (message.t === "checklist") {
    if (message.changed === true && !Array.isArray(message.items)) {
      return { ...state, checklistNonce: state.checklistNonce + 1 };
    }
    return {
      ...state,
      checklists: {
        ...state.checklists,
        [sessionId]: {
          items: Array.isArray(message.items) ? (message.items as ChecklistItem[]) : undefined,
          error: typeof message.error === "string" ? message.error : undefined,
          staleAfterDays:
            typeof message.staleAfterDays === "number" ? message.staleAfterDays : undefined,
        },
      },
    };
  }
  return state;
}

const TASK_STATUSES = new Set<string>(["pending", "in-progress", "done"]);

function isTask(value: unknown): value is TaskItem {
  if (typeof value !== "object" || value === null) return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.title === "string" &&
    typeof t.prompt === "string" &&
    typeof t.status === "string" &&
    TASK_STATUSES.has(t.status) &&
    (typeof t.runPrompt === "string" || t.runPrompt === null)
  );
}

/** A `tasks` frame: the answer to `tasks` or `task.start`, replacing that session's list. */
export function applyTasksMessage(
  state: GgState,
  message: { t: string } & Record<string, unknown>,
): GgState {
  const sessionId = message.sessionId;
  if (message.t !== "tasks" || typeof sessionId !== "string") return state;
  return {
    ...state,
    tasks: {
      ...state.tasks,
      [sessionId]: {
        items: Array.isArray(message.items) ? message.items.filter(isTask) : undefined,
        error: typeof message.error === "string" ? message.error : undefined,
        requestId: typeof message.requestId === "string" ? message.requestId : undefined,
      },
    },
  };
}

/** Show a task as started the moment Run is tapped; the daemon's answer then replaces it. */
export function markTaskStarted(state: GgState, sessionId: string, taskId: string): GgState {
  const here = state.tasks[sessionId];
  if (!here?.items) return state;
  return {
    ...state,
    tasks: {
      ...state.tasks,
      [sessionId]: {
        ...here,
        items: here.items.map((t) =>
          t.id === taskId ? { ...t, status: "in-progress" as const, runPrompt: null } : t,
        ),
      },
    },
  };
}
