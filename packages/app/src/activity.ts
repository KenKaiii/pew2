/**
 * What the agent is doing right now, and what it did once the turn is over.
 *
 * Pure and React-free for the same reason `chunks.ts` is: `bun test` cannot
 * parse React Native's Flow syntax, and this is the file where the rules worth
 * testing live. `ui/ActivityLine.tsx` and `ui/TurnReceipt.tsx` only draw it.
 *
 * ACP reports every tool the model invokes as a `tool_call` and then revises it
 * with `tool_call_update`s, so a turn is a stream of small status changes that
 * nothing in this app used to render. Folding them into one "current tool" is
 * what turns that stream into a single live line, and counting them is what
 * lets the finished turn state what it actually did instead of vanishing.
 *
 * Nothing here is invented: the duration is measured on this device, the tool
 * count is what the agent reported, and tokens are shown *only* when the agent
 * sent a usage figure of its own.
 */
import { readChunk } from "./chunks";

/** ACP tool kinds. `other` is the documented default. */
export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other";

export type ToolStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolRun {
  id: string;
  /** The agent's own human-readable title, e.g. "Reading configuration file". */
  title: string;
  kind: ToolKind;
  status: ToolStatus;
}

export interface Activity {
  /** When the turn began, by this device's clock. Absent when nothing is running. */
  startedAt?: number;
  /** Every tool this turn, in arrival order. */
  tools: ToolRun[];
  /**
   * The agent has said something since its last tool call.
   *
   * A turn alternates — tools, prose, more tools — so this is *ordering*, not a
   * latch: agent text sets it, the next tool clears it. It is what lets the
   * activity line step aside while the answer streams (the words are their own
   * proof of life; a tool name beside them describes work already finished) and
   * come back the moment the agent picks up another tool.
   */
  speaking: boolean;
  /** Total tokens, only when the agent reported usage. */
  tokens?: number;
}

/** No turn in flight. Shared instance so identity comparison stays cheap. */
export const IDLE_ACTIVITY: Activity = { tools: [], speaking: false };

const KINDS = new Set<ToolKind>([
  "read",
  "edit",
  "delete",
  "move",
  "search",
  "execute",
  "think",
  "fetch",
  "other",
]);

const STATUSES = new Set<ToolStatus>(["pending", "in_progress", "completed", "failed"]);

function readKind(value: unknown): ToolKind {
  return typeof value === "string" && KINDS.has(value as ToolKind)
    ? (value as ToolKind)
    : "other";
}

function readStatus(value: unknown): ToolStatus | undefined {
  return typeof value === "string" && STATUSES.has(value as ToolStatus)
    ? (value as ToolStatus)
    : undefined;
}

/** A turn is starting: the clock starts here, on the device that will show it. */
export function beginActivity(now: number): Activity {
  return { startedAt: now, tools: [], speaking: false };
}

/**
 * Whether a turn is being timed by *this* device.
 *
 * The distinction a `session.replay` frame turns on. Every session gets one the
 * moment it goes live, so that frame arrives in two very different situations:
 * a conversation just created to carry a first prompt, where a turn is running
 * here and its clock must survive; and an old conversation being reopened,
 * where the transcript is history and the frame should settle it to idle.
 *
 * `busy` cannot tell those apart — it is set on the way into a resumed session
 * too, because the agent may genuinely still be mid-turn on the desktop. A
 * clock this device started can.
 */
export function isTimingTurn(state: Activity): boolean {
  return state.startedAt !== undefined;
}

/**
 * Fold one `session/update` payload into the live activity.
 *
 * Returns the same object when nothing changed, so the transcript's memoised
 * footer does not re-render on every streamed word of prose.
 */
export function foldActivity(state: Activity, payload: any, now: number): Activity {
  const update = payload?.update;
  const kind = update?.sessionUpdate;
  if (kind !== "tool_call" && kind !== "tool_call_update") {
    // Read through `readChunk` rather than sniffing the payload, so "the agent
    // is talking" means exactly what the transcript decided to render — a
    // replayed summary marker is filtered there and must not count here either.
    // Thinking deliberately does not count: it collapses to one static row, so
    // treating it as speech would hide the tool line for the whole reasoning
    // phase, which on a remote agent is minutes with nothing moving.
    const chunk = readChunk(payload);
    const speaking =
      chunk?.role === "agent" && (chunk.text.trim().length > 0 || !!chunk.images?.length);

    // Only a tool call takes it back down, so an event that is neither speech
    // nor a tool leaves the flag — and the object — exactly as it was.
    const next = speaking || state.speaking;
    const tokens = readTokens(payload);
    if (next === state.speaking && (tokens === undefined || tokens === state.tokens)) return state;
    return { ...state, speaking: next, tokens: tokens ?? state.tokens };
  }

  const id = typeof update.toolCallId === "string" ? update.toolCallId : undefined;
  if (!id) return state;

  // A tool can arrive before the prompt echo does, so the clock is started here
  // too rather than assuming `beginActivity` already ran.
  const startedAt = state.startedAt ?? now;
  const at = state.tools.findIndex((tool) => tool.id === id);

  if (at < 0) {
    // Only `tool_call` carries a title; an update for a tool this client never
    // saw (a reconnect mid-turn) still counts as work, so it is kept with
    // whatever it has rather than dropped.
    const tool: ToolRun = {
      id,
      title: typeof update.title === "string" ? update.title.trim() : "",
      kind: readKind(update.kind),
      status: readStatus(update.status) ?? "pending",
    };
    // A new tool is new work, so the agent is no longer merely talking: the
    // line comes back, naming this one.
    return { ...state, startedAt, speaking: false, tools: [...state.tools, tool] };
  }

  // "All fields except toolCallId are optional in updates" — so an absent field
  // means unchanged, never cleared.
  const previous = state.tools[at]!;
  const next: ToolRun = {
    ...previous,
    title:
      typeof update.title === "string" && update.title.trim()
        ? update.title.trim()
        : previous.title,
    kind: update.kind === undefined ? previous.kind : readKind(update.kind),
    status: readStatus(update.status) ?? previous.status,
  };
  if (
    next.title === previous.title &&
    next.kind === previous.kind &&
    next.status === previous.status
  ) {
    return state;
  }

  const tools = [...state.tools];
  tools[at] = next;
  // A tool going back to running is work resuming; one merely reporting that it
  // finished is not, and must not yank the line back over a streaming answer.
  const running = next.status === "pending" || next.status === "in_progress";
  return { ...state, startedAt, speaking: running ? false : state.speaking, tools };
}

/**
 * A token figure the agent volunteered.
 *
 * ACP has no usage field, so this is deliberately a sniff of the `_meta`
 * escape hatch several agents use. Absent means the receipt simply does not
 * mention tokens — a made-up number would be worse than a missing one.
 */
function readTokens(payload: any): number | undefined {
  const meta = payload?.update?._meta ?? payload?._meta ?? payload;
  const usage = meta?.usage ?? meta?.tokenUsage ?? meta?.tokens;
  if (typeof usage === "number") return Number.isFinite(usage) ? usage : undefined;
  if (!usage || typeof usage !== "object") return undefined;

  const total = usage.total ?? usage.totalTokens ?? usage.total_tokens;
  if (typeof total === "number") return total;

  const input = usage.input ?? usage.inputTokens ?? usage.input_tokens ?? 0;
  const output = usage.output ?? usage.outputTokens ?? usage.output_tokens ?? 0;
  const sum = (typeof input === "number" ? input : 0) + (typeof output === "number" ? output : 0);
  return sum > 0 ? sum : undefined;
}

/**
 * The tool the line should name, or nothing when there is none to name.
 *
 * Newest rather than oldest because agents run tools in parallel and the last
 * one announced is the one whose result is still being waited on — and falling
 * back to the newest finished tool keeps the line from blinking out in the gap
 * between one tool completing and the next being announced.
 *
 * Silent while the agent is speaking: the answer is its own proof of life, and
 * a tool name sitting beside streaming prose describes work that is already
 * over. The next tool call clears `speaking` and brings the line straight back.
 */
export function currentTool(state: Activity): ToolRun | undefined {
  if (state.speaking) return undefined;
  for (let i = state.tools.length - 1; i >= 0; i--) {
    const tool = state.tools[i]!;
    if (tool.status === "pending" || tool.status === "in_progress") return tool;
  }
  return state.tools[state.tools.length - 1];
}

/** How many other tools are running behind the one being named. */
export function queuedTools(state: Activity): number {
  const running = state.tools.filter(
    (tool) => tool.status === "pending" || tool.status === "in_progress",
  ).length;
  return Math.max(0, running - 1);
}

export interface TurnReceipt {
  /** What the turn did, e.g. "Edited & ran". */
  verb: string;
  /** Measured on this device, from the prompt to the idle notice. */
  duration: string;
  /** Tool calls the agent reported. Zero for a plain answer. */
  tools: number;
  /** How many of those failed. Its own fact, not a suffix on the verb. */
  failed: number;
  /** Only when the agent reported usage. */
  tokens?: string;
}

/**
 * Families of work, in the order they are named. Reading a file to then edit it
 * is one act, so the family that changed something leads: "Edited & searched"
 * says what happened, "Searched & edited" reads as a list of tool names.
 */
const FAMILIES: { kinds: ToolKind[]; verb: string }[] = [
  { kinds: ["edit", "delete", "move"], verb: "Edited" },
  { kinds: ["execute"], verb: "Ran" },
  { kinds: ["read", "search"], verb: "Explored" },
  { kinds: ["fetch"], verb: "Fetched" },
];

function verbFor(tools: ToolRun[]): string {
  const kinds = new Set(tools.map((tool) => tool.kind));
  const verbs = FAMILIES.filter((family) => family.kinds.some((kind) => kinds.has(kind))).map(
    (family) => family.verb,
  );
  if (verbs.length === 0) return tools.length > 0 ? "Worked" : "Answered";
  // Two at most: a turn that touched everything reads as noise otherwise.
  const [first, second] = verbs;
  return second ? `${first} & ${second!.toLowerCase()}` : first!;
}

/**
 * The receipt for a turn that has just ended.
 *
 * Returns undefined when there is nothing measured to report — a resumed
 * transcript or a turn this client only joined halfway through, where a
 * duration would be a fiction.
 */
export function summariseActivity(state: Activity, endedAt: number): TurnReceipt | undefined {
  if (state.startedAt === undefined) return undefined;
  const elapsed = Math.max(0, endedAt - state.startedAt);
  // Under a second is not worth a receipt: a cancelled or instantly-failed turn
  // would otherwise leave "Answered in 0s" sitting under the transcript.
  if (elapsed < 1000) return undefined;

  return {
    verb: verbFor(state.tools),
    duration: formatDuration(elapsed),
    tools: state.tools.length,
    failed: state.tools.filter((tool) => tool.status === "failed").length,
    tokens: state.tokens !== undefined ? formatTokens(state.tokens) : undefined,
  };
}

/** "8s", "1m 53s", "1h 4m". Never a bare millisecond count. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** "820", "1.5k", "12k", "1.2M". One glance, not an accountant's figure. */
export function formatTokens(count: number): string {
  if (count < 1000) return `${Math.round(count)}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/** The receipt as one line, for a screen reader and for the row itself. */
export function receiptText(receipt: TurnReceipt): string {
  const parts = [`${receipt.verb} in ${receipt.duration}`];
  if (receipt.tools > 0) parts.push(`${receipt.tools} ${receipt.tools === 1 ? "tool" : "tools"}`);
  // Said plainly and last, where a count belongs. "Ran with errors in 1m 53s"
  // buries the number inside the verb and reads as one long apology.
  if (receipt.failed > 0) parts.push(`${receipt.failed} failed`);
  if (receipt.tokens) parts.push(`↓ ${receipt.tokens} tokens`);
  return parts.join(" · ");
}
