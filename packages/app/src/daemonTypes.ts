/**
 * The shapes `useDaemon` hands to the UI: agents, conversations, turns and the
 * workspace picker.
 *
 * Kept apart from the hook so the types can be read (and imported by pure
 * modules) without the 2,000 lines of socket handling around them.
 * `useDaemon.ts` re-exports every one, so existing imports keep working.
 */
import type { TurnReceipt } from "./activity";
import type { KenMeta } from "./chunks";
import type { ContextUsage } from "./contextUsage";
import type { ChatImage } from "./images";

export type Status = "connecting" | "online" | "offline";

export interface Provider {
  id: string;
  name: string;
  description: string;
  available: boolean;
  unavailableReason?: string;
  color?: string;
}

/**
 * A desktop-local image being brought to the phone.
 *
 * `error` is a first-class state, not a silent failure: the whole point of this
 * path is that a missing picture explains itself instead of leaving a blank.
 */
export type ImageEntry =
  | { status: "loading" }
  | { status: "ready"; dataUri: string; mimeType?: string }
  | { status: "error"; message: string };

export interface PermissionRequest {
  requestId: string;
  title: string;
  options: { optionId: string; name: string }[];
}

export interface Turn {
  id: string;
  /** Only on a task's opening note: the title, drawn as GG Coder's "Task:" row. */
  task?: string;
  /**
   * Stable React identity, fixed for the life of the message.
   *
   * `id` is not that: an optimistic prompt adopts the server's id once the
   * daemon echoes it back, and the thread is a recycling list keyed by this,
   * so a changing key tears the cell down and re-parses its markdown — the
   * prompt visibly rendering a second time a moment after you sent it. Absent
   * on turns born with a server id, which never changes.
   */
  key?: string;
  role: "user" | "agent" | "thought" | "system" | "ken" | "note";
  text: string;
  /** Only on role "ken": the Autopilot phase and round. */
  ken?: KenMeta;
  /**
   * Pictures the agent sent with this message, in order. Kept beside the text
   * rather than spliced into it: the bytes may be inline base64 (megabytes of
   * it) and markdown is re-parsed on every streamed chunk.
   */
  images?: ChatImage[];
  /**
   * Typed with no way to send it, and waiting in the outbox for a socket.
   *
   * Rendered as the message it is, with a mark saying it has not left the
   * phone — not as a failure, because it has not failed: the reconnect sends
   * it. Cleared the moment it goes out, and again by the daemon's echo, so a
   * bubble can never keep the label after the agent has the message.
   */
  queued?: boolean;
}

/**
 * A session-level selector advertised by the connected agent: model, thinking
 * level, or mode. pew2 hardcodes no model names — each app reports its own.
 * https://agentclientprotocol.com/protocol/v1/session-config-options
 */
export interface ConfigOption {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue: string | boolean;
  options?: { value: string; name: string; description?: string }[];
}

/** A past conversation, grouped by the agent that ran it. */
export interface Session {
  id: string;
  providerId: string;
  /** First user message, used as the list title. */
  title: string;
  startedAt: number;
  turns: Turn[];
  /** Message rows available before this transcript is opened. */
  messageCount?: number;
  /** The selectors this session was running with, restored when reopened. */
  configOptions: ConfigOption[];
  /**
   * The agent's own id for this conversation, when it came from the agent's
   * history rather than this app. Present means it has not been opened yet:
   * its turns live on the agent's disk and arrive on resume.
   */
  agentSessionId?: string;
  /** Working directory the agent recorded, needed to reopen it there. */
  cwd?: string;
  /**
   * This conversation's last context reading, held with it like its turns.
   * Leaving a chat clears the on-screen reading, and coming back replays only
   * events this phone hasn't seen, which never includes the old reading: the
   * context sheet then said the agent "doesn't report context usage".
   */
  usage?: ContextUsage;
  /**
   * Project name for the drawer, as the daemon stamped it on a finished turn.
   * Only the desktop can resolve it, and a session this app started has no
   * `cwd` of its own to derive it from.
   */
  folder?: string;
  /**
   * The agent is mid-turn in this conversation, whether or not it is on
   * screen.
   *
   * Per session rather than the single `busy` flag because the daemon keeps
   * every session running while the phone looks at one of them: leaving a
   * conversation does not stop its agent, so the drawer has to be able to say
   * which ones are still working.
   */
  busy?: boolean;
  /**
   * What this conversation's last finished turn did, e.g. "Answered in 3s".
   *
   * Kept per session because it is a fact about the turn, not about the screen.
   * It used to live only in the screen state, so it appeared as the turn ended
   * and was gone the moment the user looked at another conversation and came
   * back — the line was there while you watched it happen and never again.
   * Reopening now restores the same summary the turn produced.
   */
  receipt?: TurnReceipt;
  /**
   * A turn finished here while the user was somewhere else. Cleared when the
   * conversation is opened, so the drawer marks what is worth going back to.
   */
  unread?: boolean;
  /**
   * The approval this conversation's agent is stopped on, if any.
   *
   * Per session for the same reason as `busy`: the agent that needs an answer
   * is often not the one on screen, and it will wait for ever — there is no
   * timeout at either end of ACP. Held here, it survives switching away, and
   * survives losing the socket, since the daemon re-states every open request
   * on reconnect. Cleared when it is answered, or when the turn it belonged to
   * ends without it.
   */
  permission?: PermissionRequest;
}

/**
 * The project the open session is working in, as the daemon sees it.
 *
 * Only the desktop can answer this, and it goes stale the moment the agent
 * edits a file, so it is re-asked rather than remembered across sessions.
 */
export interface Workspace {
  cwd: string;
  folder: string;
  repo?: boolean;
  uncommitted?: number;
}

/** A directory offered by the picker: a suggested repo, or a browsed folder. */
export interface WorkspaceEntry {
  path: string;
  name: string;
  repo: boolean;
  updatedAt?: string;
  /** Absent means folder (older daemons list folders only). */
  kind?: "folder" | "file";
}

/**
 * The state of browsing for somewhere to work.
 *
 * Held here rather than inside the sheet so an in-flight answer survives the
 * sheet unmounting, and so a reply for a directory the user has already
 * navigated away from can be dropped by comparing `requestId`.
 */
export interface WorkspaceBrowse {
  /** The directory being shown. Absent while showing suggested repositories. */
  path?: string;
  /** Where "up" leads, absent at the top of what may be browsed. */
  parent?: string;
  entries: WorkspaceEntry[];
  loading: boolean;
  /** The daemon would not open that path: missing, a file, or out of bounds. */
  refused: boolean;
  /**
   * The request never left the phone (offline, or the socket not open yet).
   * Distinct from an empty answer: a picker that opened before the connection
   * did asks again once it is online, instead of saying "Nothing here".
   */
  unsent?: boolean;
}
