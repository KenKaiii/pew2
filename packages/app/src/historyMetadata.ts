import { folderName } from "./projectFolder";
import type { Session } from "./useDaemon";

/** Text rendered below a conversation title in the history drawer. */
export function formatHistoryMetadata(
  session: Pick<Session, "cwd" | "folder" | "messageCount"> & { turns?: readonly unknown[] },
): string {
  // A conversation this app started has no `cwd` of its own; the daemon stamps
  // the project onto its first finished turn instead.
  const project = folderName(session.cwd) ?? session.folder;
  // A loaded transcript is freshest. Before opening, use the count supplied by
  // the daemon's session-list probe.
  const messageCount = session.turns?.length ? session.turns.length : session.messageCount;
  const count =
    messageCount === undefined
      ? undefined
      : `${messageCount} message${messageCount === 1 ? "" : "s"}`;

  return [count, project].filter(Boolean).join(" · ");
}

/** Sidebar's complete data contract, deliberately excluding transcript/config. */
export type DrawerRow = Pick<Session, "id" | "providerId" | "title" | "startedAt" | "cwd" | "folder" | "messageCount" | "busy" | "unread" | "permission">;

/** Bounded by the retained session list; no second transcript cache. Pure so it
 * remains safe when React retries a render or state updater. */
export function projectDrawerRows(previous: DrawerRow[], sessions: readonly Session[]): DrawerRow[] {
  const byId = new Map(previous.map((row) => [row.id, row]));
  const rows = sessions.map((session): DrawerRow => {
    const row: DrawerRow = {
      id: session.id, providerId: session.providerId, title: session.title,
      startedAt: session.startedAt, cwd: session.cwd, folder: session.folder,
      messageCount: session.turns.length || session.messageCount,
      busy: session.busy === true, unread: session.unread === true, permission: session.permission,
    };
    const old = byId.get(row.id);
    return old && (Object.keys(row) as (keyof DrawerRow)[]).every((key) => Object.is(old[key], row[key])) ? old : row;
  });
  return rows.length === previous.length && rows.every((row, index) => row === previous[index]) ? previous : rows;
}
