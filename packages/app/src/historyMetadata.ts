import { folderName } from "./projectFolder";
import type { Session } from "./useDaemon";

/** Text rendered below a conversation title in the history drawer. */
export function formatHistoryMetadata(
  session: Pick<Session, "cwd" | "folder" | "messageCount" | "turns">,
): string {
  // A conversation this app started has no `cwd` of its own; the daemon stamps
  // the project onto its first finished turn instead.
  const project = folderName(session.cwd) ?? session.folder;
  // A loaded transcript is freshest. Before opening, use the count supplied by
  // the daemon's session-list probe.
  const messageCount = session.turns.length > 0 ? session.turns.length : session.messageCount;
  const count =
    messageCount === undefined
      ? undefined
      : `${messageCount} message${messageCount === 1 ? "" : "s"}`;

  return [count, project].filter(Boolean).join(" · ");
}
