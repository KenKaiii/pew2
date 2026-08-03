/**
 * When a finished turn is worth a notification, and what it should say.
 *
 * pew2's whole premise is that the agent keeps working while the phone is in a
 * pocket or on another conversation. A banner is therefore not decoration: it
 * is the only way to learn that a five-minute turn in another project has
 * landed. This module decides that, and nothing else — no Expo imports, so the
 * rule is testable under `bun test`, which cannot parse React Native's Flow
 * syntax. `ui/notifier.ts` binds the SDK. Same split as
 * `hapticsPolicy.ts`/`ui/haptics.ts`.
 */

/** What the app knows the moment a session goes idle. */
export interface FinishedTurn {
  sessionId: string;
  /** Last path segment of the agent's cwd, as the daemon stamped it. */
  folder?: string;
  /** Display name of the agent that ran the turn, e.g. "Claude Code". */
  agentName?: string;
  /** The agent's closing message, used as the banner body when there is one. */
  lastText?: string;
  /** The conversation currently on screen, if any. */
  activeSessionId?: string;
  /** False when the app is backgrounded or inactive. */
  foreground: boolean;
}

export interface Notice {
  title: string;
  body: string;
  /** Carried through the notification so a tap can open this conversation. */
  sessionId: string;
}

/**
 * A banner body longer than this is truncated by the OS anyway, and a wall of
 * markdown on a lock screen is unreadable. One sentence's worth.
 */
const MAX_BODY = 140;

/**
 * Reduce an agent's closing message to one line of plain-ish text.
 *
 * Agent replies are markdown: headings, bullets and fenced code render as
 * literal `##` and backticks in a notification. Taking the first non-empty,
 * non-fence line and stripping the leading markers gets a sentence people can
 * read at a glance without pulling a markdown renderer into this path.
 */
export function summarise(text: string | undefined): string | undefined {
  if (!text) return undefined;
  let inFence = false;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("```")) {
      // A code block's contents say nothing useful out of context.
      inFence = !inFence;
      continue;
    }
    if (inFence || line.length === 0) continue;
    const clean = line
      // Leading block markers: "## ", "- ", "* ", "> ", "1. ".
      .replace(/^([#>*-]+|\d+\.)\s+/, "")
      // Inline emphasis and code ticks, which read as noise rather than style.
      .replace(/[*_`]/g, "")
      .trim();
    if (clean.length === 0) continue;
    return clean.length > MAX_BODY ? `${clean.slice(0, MAX_BODY - 1)}…` : clean;
  }
  return undefined;
}

/**
 * The banner for a turn that just ended, or null when it is not worth showing.
 *
 * Suppressed only when the user is already looking at that conversation in the
 * foreground: the reply is on screen, and a banner over it is noise. Every
 * other case — app backgrounded, or reading a different session — is exactly
 * the case this feature exists for.
 */
export function finishedNotice(turn: FinishedTurn): Notice | null {
  const watching = turn.foreground && turn.activeSessionId === turn.sessionId;
  if (watching) return null;

  // The project first: it is how people identify which of several running
  // agents this is, and it is the only word guaranteed to survive truncation
  // in a narrow banner.
  const title = turn.folder
    ? turn.agentName
      ? `${turn.folder} · ${turn.agentName}`
      : turn.folder
    : (turn.agentName ?? "pew2");

  return {
    title,
    // Falls back to a statement rather than an empty body: a turn can finish
    // having only run tools, with no closing message at all.
    body: summarise(turn.lastText) ?? "Finished and waiting on you.",
    sessionId: turn.sessionId,
  };
}
