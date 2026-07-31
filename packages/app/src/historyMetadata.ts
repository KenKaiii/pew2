import { folderName } from "./projectFolder";
import type { Session } from "./useDaemon";

/** Text rendered below a conversation title in the history drawer. */
export function formatHistoryMetadata(
  session: Pick<Session, "agentSessionId" | "cwd" | "turns">,
): string {
  const project = folderName(session.cwd);
  // Agent-history stubs have not loaded their transcript yet, so their message
  // count is unknown rather than zero.
  const count =
    session.agentSessionId && session.turns.length === 0
      ? undefined
      : `${session.turns.length} message${session.turns.length === 1 ? "" : "s"}`;

  return [count, project].filter(Boolean).join(" · ");
}
