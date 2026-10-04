/** Per-chat delivery state, updated synchronously rather than during React renders. */
export class PromptGate {
  private readonly working = new Set<string>();
  private readonly syncing = new Set<string>();
  private readonly permissions = new Set<string>();

  canSend(sessionId: string): boolean {
    return !this.working.has(sessionId) && !this.syncing.has(sessionId) && !this.permissions.has(sessionId);
  }

  started(sessionId: string): void {
    this.working.add(sessionId);
  }

  waitForPermission(sessionId: string): void {
    this.permissions.add(sessionId);
  }

  finished(sessionId: string): void {
    this.working.delete(sessionId);
    this.syncing.delete(sessionId);
    this.permissions.delete(sessionId);
  }

  /** Session ids are process-local; a restarted daemon retires the old gates. */
  retain(sessionIds: ReadonlySet<string>): void {
    for (const sessionId of this.working) {
      if (!sessionIds.has(sessionId)) this.working.delete(sessionId);
    }
    for (const sessionId of this.syncing) {
      if (!sessionIds.has(sessionId)) this.syncing.delete(sessionId);
    }
    for (const sessionId of this.permissions) {
      if (!sessionIds.has(sessionId)) this.permissions.delete(sessionId);
    }
  }

  /** A socket opening says nothing about whether the desktop is still working. */
  reconnect(sessionIds: Iterable<string>): void {
    for (const sessionId of [...this.working, ...this.permissions, ...sessionIds]) {
      this.syncing.add(sessionId);
    }
    // Idle is not replayed, so pre-disconnect work may already have finished.
    // Keep known approvals, but rebuild working state on the new connection.
    this.working.clear();
  }

  /** Only a current catch-up snapshot, not historical replay, can release work. */
  catchUp(sessionId: string, working: unknown, permissions: unknown): void {
    this.syncing.delete(sessionId);
    // Older peers omit working. End the catch-up wait without erasing live
    // work seen on this connection or approvals the older peer says nothing
    // about. A silent legacy agent's activity cannot be inferred from history.
    if (working === true) this.working.add(sessionId);
    else if (working === false) this.working.delete(sessionId);
    if (Array.isArray(permissions)) {
      if (permissions.length > 0) this.permissions.add(sessionId);
      else this.permissions.delete(sessionId);
    }
  }
}
