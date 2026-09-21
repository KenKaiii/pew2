import type { Session, Status } from "./useDaemon";

export type RestoreTarget = Pick<Session, "id" | "providerId" | "agentSessionId" | "title" | "cwd">;
export function restoreTarget(session: Session): RestoreTarget {
  return { id: session.id, providerId: session.providerId, agentSessionId: session.agentSessionId, title: session.title, cwd: session.cwd };
}
export function matchesRestore(target: RestoreTarget | undefined, message: { providerId?: string; agentSessionId?: string }): boolean {
  // Older peers may omit either optional identity field. Never guess past a
  // field they did supply, particularly when two restores cross in flight.
  return !!target && (!message.providerId || message.providerId === target.providerId) &&
    (!message.agentSessionId || message.agentSessionId === target.agentSessionId);
}
export type RestorePresentation = "loading" | "reconnecting" | "failed" | "empty" | undefined;
export function restorePresentation(target: RestoreTarget | undefined, loading: boolean, error: string | undefined, count: number, status: Status): RestorePresentation {
  if (!target) return undefined;
  if (error) return "failed";
  if (count > 0) return undefined;
  if (loading) return status === "online" ? "loading" : "reconnecting";
  return "empty";
}
