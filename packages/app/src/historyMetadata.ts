import { folderName } from "./projectFolder";
import type { Session } from "./useDaemon";

/** Text rendered below a conversation title in the history drawer. */
export function formatHistoryMetadata(
  session: Pick<Session, "cwd" | "messageCount" | "turns">,
): string {
  const project = folderName(session.cwd);
  // A loaded transcript is freshest. Before opening, use the count supplied by
  // the daemon's session-list probe.
  const messageCount = session.turns.length > 0 ? session.turns.length : session.messageCount;
  const count =
    messageCount === undefined
      ? undefined
      : `${messageCount} message${messageCount === 1 ? "" : "s"}`;

  return [count, project].filter(Boolean).join(" · ");
}
