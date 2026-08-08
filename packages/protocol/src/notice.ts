/**
 * What an "agent finished" banner says.
 *
 * Lives in the protocol package because two processes now compose the same
 * banner and they must not drift. The app builds it from `session.idle` when it
 * is awake; the daemon builds it for a remote push when the phone's JavaScript
 * has been suspended and that message will not arrive for minutes. Two copies of
 * this formatting would mean the notification you get depends on whether the app
 * happened to still be running, which is precisely the difference the user
 * cannot see and would report as a bug.
 *
 * Deliberately free of Expo, React Native and Node imports so it stays
 * importable from both sides and testable under `bun test`.
 */

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

/** Where a finished turn ran, as far as any banner is concerned. */
export interface NoticeOrigin {
  /** Last path segment of the agent's cwd, as the daemon stamped it. */
  folder?: string;
  /** Display name of the agent that ran the turn, e.g. "Claude Code". */
  agentName?: string;
}

/**
 * The banner's first line.
 *
 * The project comes first: it is how people identify which of several running
 * agents this is, and it is the only word guaranteed to survive truncation in a
 * narrow banner.
 */
export function noticeTitle(origin: NoticeOrigin): string {
  if (!origin.folder) return origin.agentName ?? "pew2";
  return origin.agentName ? `${origin.folder} · ${origin.agentName}` : origin.folder;
}

/**
 * The banner's body: what the agent actually said.
 *
 * Falls back to a statement rather than an empty body, because a turn can finish
 * having only run tools with no closing message at all.
 */
export function noticeBody(lastText: string | undefined): string {
  return summarise(lastText) ?? "Finished and waiting on you.";
}
