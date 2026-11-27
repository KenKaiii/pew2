/**
 * Module-level types and helpers shared by the Daemon's layers.
 *
 * Moved out of `index.ts` unchanged; `index.ts` re-exports the public ones.
 */
import type { LoadedProvider } from "../providers/registry.js";
import type {
  AcpSessionHandle,
  AdoptOptions,
  AgentSession,
  AvailableCommand,
  ConfigOption,
} from "../acp/connect.js";
import type { SessionLog } from "../session/log.js";
import { homedir as __homedir } from "node:os";
import { join as __join } from "node:path";
const homedir = __homedir;
const join = __join;
import type { StoredAttachment } from "../attachments.js";
import type { AgentProject } from "../projects.js";
import { SESSION_HISTORY_LIMIT } from "../session-history.js";
import type { wire } from "@pew2/protocol";

/** A project task to run in a fresh context: what `task.start` claimed. */
export interface TaskRun {
  id: string;
  title: string;
  /** The task's prompt plus GG Coder's mark-it-done hint. */
  prompt: string;
}

/** The per-session receivers an agent connection reports into. */
export type SessionCallbacks = Omit<AdoptOptions, "cwd" | "loadSessionId" | "haveHistory">;

export interface ActiveSession {
  handle?: AcpSessionHandle;
  log: SessionLog;
  /** Which agent this belongs to, so a config change knows what to remember. */
  providerId: string;
  /**
   * The agent's own id for this conversation, learned once it is open.
   *
   * Session ids here are the daemon's, assigned before the agent answers, so
   * this is the only thing that identifies the *same conversation* across a
   * restart — it keys the per-session selectors and lets the app collapse the
   * agent's disk-history stub onto the live session instead of listing both.
   */
  agentSessionId?: string;
  /**
   * The directory the agent was started in.
   *
   * Kept because agent output names files relative to it — an image the agent
   * generated is `.gg/generated/x.png` and nothing else, so serving it to the
   * phone needs the root that path was written against.
   */
  cwd: string;
  /** Resolves once the agent has loaded and can accept prompts/config changes. */
  ready: Promise<void>;
  /** Whether clients have been told this session exists. */
  live: boolean;
  /**
   * When this conversation was last opened, prompted, or answered.
   *
   * A session holds a whole agent process — GG Coder measures 90-330MB, Claude
   * Code 350MB+ — and nothing used to end one. Every conversation opened in a
   * run left its agent resident until the daemon died, which on a machine left
   * running for a day meant eleven GG Coder processes and 2.2GB for
   * conversations last touched hours earlier.
   *
   * Reaping needs this rather than the log's last entry because opening a
   * conversation and reading it is use, and produces no events at all.
   */
  lastUsedAt: number;
  /**
   * A turn is in flight.
   *
   * The agent is working even when it is silent — thinking, or running a long
   * tool — so elapsed quiet is not evidence a session can be closed. This is
   * the flag that keeps the reaper off a running turn.
   */
  working?: boolean;
  /**
   * Approval requests the agent is blocked on, oldest first.
   *
   * The ACP request is still open — its resolver is sitting in the connection
   * waiting for `answerPermission` — and nothing but this daemon knows that. A
   * client that was offline when it was asked has no way back to it: the logged
   * `permission_request` event is skipped on replay (in history it was answered
   * long ago), so the sheet never reappeared and the turn stayed stopped for
   * ever. `catchUp` hands these back so a reconnecting phone can answer.
   *
   * Keyed by request id and insertion-ordered: an agent can have several tools
   * in flight, and answering one must not drop the rest.
   */
  permissions?: Map<string, unknown>;
  /**
   * What the agent has said so far in the current turn.
   *
   * Only the daemon can supply the body of a push notification: by the time a
   * long turn ends, the phone's JavaScript has been suspended for minutes and
   * it has received none of these chunks. Kept per session and reset at the
   * start of each turn, so a push always quotes the reply it is announcing
   * rather than the previous one.
   *
   * Capped, because a turn can emit megabytes and a banner shows one line.
   */
  turnText?: string;
  /**
   * Messages sent while a turn was running, oldest first. Live state, never
   * logged: an entry becomes a `user_message` only when it reaches the agent.
   */
  queue?: QueueEntry[];
  /**
   * The user stopped this turn. New queue entries are held back from the
   * agent's own queue until it ends, or the agent would hand them straight
   * back as cancelled.
   */
  cancelling?: boolean;
  /**
   * Forwarded entries this daemon already sent itself as a turn. The agent's
   * turn-end `returned` for them is then old news, not something new to run.
   */
  sentForwarded?: QueueEntry[];
  /** Open `_gg/ask_user` questions, by request id: same role as `permissions`. */
  asks?: Map<string, unknown[]>;
  /** Latest GG Goals state, when this session coordinates a goal. */
  goal?: wire.GoalState;
  /** Latest `_gg/plan_state`: live state, broadcast + catch-up, never logged. */
  plan?: wire.PlanState;
  /** Latest `_gg/autopilot_state`: live state, broadcast + catch-up, never logged. */
  autopilot?: wire.AutopilotState;
  /** The goal's kickoff turn has been started from here; never twice. */
  kickedOff?: boolean;
  /** Resume history is frame-batched until loading completes. */
  streamingReplay?: boolean;
  pendingReplay?: wire.SessionEvent[];
  replayTimer?: NodeJS.Timeout;
}

/** One queued message. `storing` writes its attachments; awaited when it is sent. */
export interface QueueEntry {
  id: string;
  text: string;
  attachments: number;
  storing: Promise<StoredAttachment[]>;
  /** Handed to a GG-capable agent's own queue (`_gg/queue`). */
  forwarded?: boolean;
  /** The agent's id for it, once `_gg/queue` answered. */
  agentId?: string;
}

/** The provider whose ACP connection carries GG Coder's goals extension. */
export const GG_PROVIDER_ID = "ggcoder";
/** GG Goals: the ggcoder command, offered as its own agent for goal folders only. */
export const GG_GOALS_ID = "gg-goals";

/** The GG Coder goals root: `<GG_AGENT_DIR or ~/.gg>/goals`. */
export function goalsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return join(env.GG_AGENT_DIR || join(homedir(), ".gg"), "goals");
}

/** `gg-goals`, synthesised in memory from the ggcoder provider (no manifest file). */
export function goalsProviderFrom(gg: LoadedProvider): LoadedProvider {
  return {
    ...gg,
    manifest: {
      ...gg.manifest,
      id: GG_GOALS_ID,
      name: "GG Goals",
      description: "Long-running goals: GG Goals plans, runs workers and checks in.",
      pew: { ...gg.manifest.pew, color: "#8b7cf6", requiresWorkspace: false },
    },
  };
}

/** What `prompt` did with a message: ran it (and anything queued behind it), or queued it. */
/**
 * How `prompt` ended: the turn ran to its end, was only queued behind another,
 * or was stopped by someone pressing cancel (which ACP reports as an ordinary
 * end, so only the daemon's own `cancelling` flag can tell it apart).
 */
export type PromptOutcome = "ran" | "queued" | "cancelled";

export function queuedForWire(entry: QueueEntry): wire.QueuedMessage {
  return {
    id: entry.id,
    text: entry.text,
    ...(entry.attachments > 0 ? { attachments: entry.attachments } : {}),
  };
}

/** `{ id, text }` items off a `_gg/queue_update`, ignoring junk. */
export function agentQueueItems(value: unknown): { id: string; text: string }[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const typed = item as { id?: unknown; text?: unknown } | null;
    return typeof typed?.id === "string"
      ? [{ id: typed.id, text: typeof typed.text === "string" ? typed.text : "" }]
      : [];
  });
}

/** Everything a provider can tell us before a conversation is under way. */
export interface ProviderCapabilities {
  configOptions: ConfigOption[];
  /** The agent's own stored conversations, newest first. */
  sessions: AgentSession[];
  /** Whether those sessions can actually be reopened. */
  canResume: boolean;
  /**
   * Slash commands the agent offers for this project.
   *
   * Learned from the throwaway probe session, so the app can offer them in the
   * empty state — before the first prompt has created a session to ask.
   */
  commands?: AvailableCommand[];
  /**
   * Every project the agent holds history for, newest first.
   *
   * Folded from the whole session list rather than the capped `sessions`
   * above, so the phone's project menu is complete even when a single repo
   * fills the recent history.
   */
  projects?: AgentProject[];
  /** GG Coder extensions from `agentCapabilities._meta.gg`; absent for every other agent. */
  extensions?: wire.ProviderExtensions;
}

/** `_meta.gg` as the booleans the app reads; undefined when the agent advertised none. */
export function readExtensions(
  gg: Record<string, unknown> | undefined,
): wire.ProviderExtensions | undefined {
  if (!gg) return undefined;
  const keys = ["queue", "askUser", "goals", "planReview", "autopilot", "checklist"] as const;
  const out: wire.ProviderExtensions = {};
  for (const key of keys) if (gg[key] !== undefined) out[key] = Boolean(gg[key]);
  // The daemon reads the task file itself, so any GG Coder has a task list.
  out.tasks = true;
  return out;
}

export const AUTOPILOT_PHASES = new Set([
  "review_start",
  "prompted",
  "done",
  "human",
  "capped",
  "ignored",
  "plan_accepted",
  "error",
]);

/**
 * Show a selector at the value it will actually take.
 *
 * A stored preference is applied when a session opens, so a capability reply
 * that reported the agent's default would be describing a state that never
 * reaches the screen. Only values the option really offers are used: a model
 * dropped between agent versions must not leave a pill naming something that
 * cannot be chosen.
 */
export function withStoredPrefs(
  options: ConfigOption[],
  prefs: Record<string, string | boolean>,
): ConfigOption[] {
  return options.map((option) => {
    const preferred = prefs[option.id];
    if (preferred === undefined) return option;
    const offered = !option.options || option.options.some((choice) => choice.value === preferred);
    return offered ? { ...option, currentValue: preferred } : option;
  });
}

export const EMPTY_CAPABILITIES: ProviderCapabilities = {
  configOptions: [],
  sessions: [],
  canResume: false,
  commands: [],
  projects: [],
};

/**
 * How many of a project's conversations the phone is offered.
 *
 * The same window the drawer already applies to recent history: a project is
 * chosen to get back to work in it, not to browse a year of archives.
 */
export const PROJECT_SESSION_LIMIT = SESSION_HISTORY_LIMIT;

export const REPLAY_BATCH_SIZE = 64;

/**
 * How much of a turn's reply is kept for the notification body.
 *
 * A banner shows about one line; `summarise` takes the first readable one. This
 * only has to be long enough to contain that line after markdown headings and
 * blank lines are skipped, and short enough that a turn emitting megabytes of
 * output does not have all of it retained per session for the sake of a banner.
 */
const TURN_TEXT_LIMIT = 2000;

/**
 * Accumulate what the agent says, for the push notification sent when the turn
 * ends.
 *
 * Reads the same ACP shape the app's `readChunk` does. It is deliberately a
 * sniff rather than a parse: this must never be able to throw on an unexpected
 * payload, because it sits directly in the path of every event a session emits.
 */
export function rememberTurnText(session: ActiveSession, payload: unknown): void {
  if ((session.turnText?.length ?? 0) >= TURN_TEXT_LIMIT) return;
  const update = (payload as { update?: { sessionUpdate?: unknown; content?: unknown } })?.update;
  if (update?.sessionUpdate !== "agent_message_chunk") return;
  // Thoughts are excluded by that check on purpose: announcing an agent's
  // reasoning rather than its answer would put the least useful sentence of the
  // turn on the lock screen.

  // A text block, as ACP sends them. Narrowed to `string` rather than left as
  // `unknown`: an agent that puts a non-string in `text` would otherwise be
  // stringified into the banner as "[object Object]".
  const blockText = (block: unknown): string => {
    const typed = block as { type?: unknown; text?: unknown } | null;
    return typed?.type === "text" && typeof typed.text === "string" ? typed.text : "";
  };
  const content = update.content;
  // Mirrors the app's `readText`: a lone block is trusted to be text, because
  // that is the only shape ACP sends outside an array, while inside an array the
  // `type` has to be checked — an image block there carries no readable text.
  const single = (content as { text?: unknown } | null)?.text;
  const text = Array.isArray(content)
    ? content.map(blockText).join("")
    : typeof single === "string"
      ? single
      : "";
  if (text.length === 0) return;
  session.turnText = `${session.turnText ?? ""}${text}`.slice(0, TURN_TEXT_LIMIT);
}
