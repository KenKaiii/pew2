/**
 * Filling in "12 messages" for a conversation nobody has opened yet.
 *
 * Loading a transcript over ACP just to count its rows takes about a second
 * each, so both agents that keep a local index get read directly instead.
 * Anything else is left undefined and the drawer simply omits the count —
 * a missing number is a far smaller cost than a list that takes a minute.
 *
 * Shared by the probe (which counts the newest sessions up front) and the
 * per-project listing (which counts a different slice on demand), so the two
 * cannot disagree about which agents have a fast path.
 */
import type { AgentSession } from "./connect.js";
import { hydrateClaudeMessageCounts } from "./claude-history.js";
import { hydrateGgCoderMessageCounts } from "./ggcoder-history.js";

/** Mutates `sessions` in place, best-effort. */
export async function hydrateMessageCounts(
  providerId: string,
  sessions: AgentSession[],
): Promise<void> {
  if (providerId === "claude-code") await hydrateClaudeMessageCounts(sessions);
  else if (providerId === "ggcoder") await hydrateGgCoderMessageCounts(sessions);
}
