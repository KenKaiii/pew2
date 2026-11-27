/**
 * Prompting, and the queue of messages sent while a turn is running —
 * including the hand-off to a GG-capable agent's own queue (`_gg/queue`).
 */
import type { PromptOptions } from "../acp/connect.js";
import { attachmentLimitError, storeAttachments, type StoredAttachment } from "../attachments.js";
import { markInProgress } from "../gg-tasks.js";
import type { wire } from "@pew2/protocol";
import { DaemonGg } from "./gg.js";
import {
  agentQueueItems,
  queuedForWire,
  type ActiveSession,
  type PromptOutcome,
  type QueueEntry,
  type TaskRun,
} from "./types.js";

/** A task run is one more kind of turn with no user words of its own. */
type TurnOptions = PromptOptions & { taskRun?: TaskRun };

export abstract class DaemonPromptQueue extends DaemonGg {
  /**
   * Send a prompt, or queue it behind the turn already running.
   *
   * ACP allows one turn at a time, so a message that arrives mid-turn is held
   * here for every agent. A GG-capable agent also gets it in its own queue and
   * folds it in at its next step; anything still queued when a turn ends goes
   * out as ONE next turn, each message logged as its own `user_message` at the
   * moment it actually reaches the agent. Resolves when the session is idle
   * again — after those follow-up turns — or at once with `"queued"`.
   */
  async prompt(
    sessionId: string,
    text: string,
    attachments: wire.PromptAttachment[] = [],
    options: TurnOptions = {},
  ): Promise<PromptOutcome> {
    const session = this.require(sessionId);
    if (session.working) {
      if (options.goalTurn) throw new Error("GG Goals is already working on this goal.");
      if (options.planDecision)
        throw new Error("The agent is still working; decide the plan when it stops.");
      if (options.taskRun)
        throw new Error("The agent is still working; run the task when it stops.");
      this.enqueue(session, text, attachments);
      return "queued";
    }
    // Use, and the start of a turn. `working` is cleared in the `finally` below
    // rather than on the agent's last word: an agent can go quiet for minutes
    // mid-tool, and a reaper that read silence as "done" would close the
    // process out from under a turn the user is waiting on.
    //
    // Set synchronously, before any await, so a second message arriving while
    // this one's attachments are written is queued rather than run beside it.
    session.lastUsedAt = Date.now();
    session.working = true;
    session.cancelling = false;
    this.touchBoard();
    // Read before the loop clears the flag: the turn's end is the only point
    // that knows it was a stop, and the push it decides on comes after.
    let cancelled = false;
    try {
      // Written before the echo: an attachment that cannot be stored (over the
      // limits, disk full) must fail the whole prompt rather than leave a turn on
      // every screen referring to a file the agent never got.
      let next:
        | {
            texts: { text: string; stored: StoredAttachment[] }[];
            goalTurn?: PromptOptions["goalTurn"];
            planDecision?: PromptOptions["planDecision"];
            taskRun?: TaskRun;
          }
        | undefined = options.goalTurn
        ? { texts: [], goalTurn: options.goalTurn }
        : options.planDecision
          ? { texts: [], planDecision: options.planDecision }
          : options.taskRun
            ? { texts: [], taskRun: options.taskRun }
            : { texts: [{ text, stored: await storeAttachments(sessionId, attachments) }] };
      try {
        while (next) {
          // A new turn, so the previous turn's closing words must not be what
          // the push notification for this one quotes.
          session.turnText = undefined;
          // Echoed before the agent is ready: the paths ride along so every
          // client — including one replaying later — can show what was sent.
          // A goal turn has no user words, so nothing is logged for it.
          for (const entry of next.texts) this.logUserMessage(session, entry.text, entry.stored);
          // A plan decision is logged as itself, not as a user message.
          if (next.planDecision) {
            const { action, feedback } = next.planDecision;
            this.record(session, {
              kind: "plan_decision",
              action,
              ...(feedback !== undefined ? { feedback } : {}),
            });
          }
          await session.ready;
          if (next.taskRun) {
            const { id, title } = next.taskRun;
            const agentSessionId = await this.resetContext(session);
            // Logged before the task file is touched: the context is already
            // fresh, and every screen should say so even if marking it fails.
            // It stands in for the user turn, which the task prompt never is.
            this.record(session, { kind: "context_reset", reason: "task", title, agentSessionId });
            await markInProgress(this.ggTasksBase, session.cwd, id);
          }
          if (next.goalTurn) {
            await session.handle!.prompt("", [], { goalTurn: next.goalTurn });
          } else if (next.planDecision) {
            await session.handle!.prompt("", [], { planDecision: next.planDecision });
          } else if (next.taskRun) {
            await session.handle!.prompt(next.taskRun.prompt);
          } else {
            await session.handle!.prompt(
              next.texts.map((entry) => entry.text).join("\n\n"),
              next.texts.flatMap((entry) => entry.stored),
            );
          }
          // The turn is over: whatever it was blocked on died with it.
          if (session.cancelling) cancelled = true;
          session.cancelling = false;
          session.permissions?.clear();
          this.touchInbox();
          next = await this.takeQueuedTurn(session);
        }
      } catch (error) {
        // A failed turn does not run what was waiting behind it: those go back
        // to the composer, exactly as a cancel hands them back.
        this.returnQueue(session);
        throw error;
      }
    } finally {
      session.working = false;
      session.cancelling = false;
      this.touchBoard();
      // A turn cannot end while the agent is still waiting to be let past a
      // tool: it is blocked on that answer. So anything left here was killed
      // with the turn — cancelled, or the agent errored out — and offering it
      // to the next client to reconnect would be an approve button wired to a
      // request no one is listening for any more.
      session.permissions?.clear();
      this.touchInbox();
      // Open asks are NOT cleared: GG Coder keeps an ask_user request open past
      // the turn that raised it, and a late answer comes back as a returned
      // queue item. They go when answered, withdrawn by the agent, or closed.
      // Touched again at the end, so the idle window is measured from when the
      // agent stopped rather than from when the user typed. A turn that ran for
      // twenty minutes would otherwise be reapable the moment it finished.
      session.lastUsedAt = Date.now();
    }
    return cancelled ? "cancelled" : "ran";
  }

  /** Log a message as the user's turn, at the moment it reaches the agent. */
  protected logUserMessage(session: ActiveSession, text: string, stored: StoredAttachment[]) {
    this.send(
      session.log.append({
        kind: "user_message",
        text,
        // Omitted entirely when there are none, so the shape of an ordinary
        // text turn — which is nearly all of them — is unchanged in the log and
        // in every replayed frame.
        ...(stored.length > 0 && {
          attachments: stored.map((file) => ({
            name: file.name,
            mimeType: file.mimeType,
            uri: file.path,
          })),
        }),
      }),
    );
  }

  /**
   * Hold a message until the running turn can take it.
   *
   * Synchronous up to the push, so the turn loop can never finish between the
   * check and the queue and strand a message on an idle session. The files are
   * written behind it and awaited when the message is sent.
   */
  protected enqueue(session: ActiveSession, text: string, attachments: wire.PromptAttachment[]) {
    const limit = attachmentLimitError(attachments);
    if (limit) throw new Error(limit);
    const id = `q_${++this.queueCounter}`;
    const storing = storeAttachments(session.log.sessionId, attachments, undefined, `${id}-`);
    // Awaited when sent; this only stops an early failure being "unhandled".
    storing.catch(() => {});
    const entry: QueueEntry = { id, text, attachments: attachments.length, storing };
    (session.queue ??= []).push(entry);
    session.lastUsedAt = Date.now();
    this.broadcastQueue(session);
    // GG's queue carries text only, so a message with files waits for the
    // next turn, where they can travel as prompt blocks.
    if (session.handle?.ggCapabilities?.queue && !session.cancelling && attachments.length === 0) {
      void this.forwardQueued(session, entry);
    }
  }

  /** Hand a queued message to a GG-capable agent's own queue. Best effort. */
  protected async forwardQueued(session: ActiveSession, entry: QueueEntry) {
    const handle = session.handle;
    if (!handle) return;
    entry.forwarded = true;
    try {
      const answer = await handle.extRequest<{ id?: unknown }>("_gg/queue", {
        sessionId: handle.sessionId,
        text: entry.text,
      });
      if (typeof answer?.id === "string") entry.agentId = answer.id;
    } catch {
      // Not mid-turn any more (-32602) or an older agent: it goes as the next
      // turn from our queue instead.
      entry.forwarded = false;
    }
  }

  /** The daemon's entry for an item the agent names. */
  protected matchQueued(session: ActiveSession, item: { id: string; text: string }) {
    const queue = session.queue ?? [];
    return (
      queue.find((entry) => entry.agentId === item.id) ??
      // The notification can beat the `_gg/queue` answer that carries the id.
      queue.find((entry) => entry.forwarded && !entry.agentId && entry.text === item.text)
    );
  }

  /** `_gg/queue_update`: drained messages became user turns; returned ones go back. */
  protected applyAgentQueueUpdate(session: ActiveSession, params: unknown) {
    const update = params as { drained?: unknown; returned?: unknown; turnEnded?: unknown } | null;
    let changed = false;
    for (const item of agentQueueItems(update?.drained)) {
      const entry = this.matchQueued(session, item);
      if (!entry) continue;
      session.queue = (session.queue ?? []).filter((queued) => queued !== entry);
      changed = true;
      // Folded into the running turn right now: that is where the agent read it.
      this.logUserMessage(session, entry.text, []);
    }
    const returned: QueueEntry[] = [];
    for (const item of agentQueueItems(update?.returned)) {
      const entry = this.matchQueued(session, item);
      if (!entry) {
        const sent = session.sentForwarded ?? [];
        const already =
          sent.find((e) => e.agentId === item.id) ??
          sent.find((e) => !e.agentId && e.text === item.text);
        if (already) {
          session.sentForwarded = sent.filter((e) => e !== already);
          continue;
        }
        // Not one of ours: GG Coder hands back text it wants run next (a late
        // ask_user answer). Same path as a leftover: the next turn.
        if (update?.turnEnded === true) this.adoptReturned(session, item.text);
        continue;
      }
      if (update?.turnEnded === true) {
        // The turn ended before a steering point. It stays in our queue, and
        // the turn loop sends it as the next turn — usually already has.
        entry.forwarded = false;
        entry.agentId = undefined;
        continue;
      }
      session.queue = (session.queue ?? []).filter((queued) => queued !== entry);
      returned.push(entry);
      changed = true;
    }
    if (changed) this.broadcastQueue(session, returned.length > 0 ? returned : undefined);
  }

  /**
   * Run text the agent handed back at turn end. Queued when a turn loop is
   * still going (it picks it up); otherwise starts one, announcing idle itself
   * since no client request is waiting on it.
   */
  protected adoptReturned(session: ActiveSession, text: string) {
    const sessionId = session.log.sessionId;
    if (session.working) {
      const entry: QueueEntry = {
        id: `q_${++this.queueCounter}`,
        text,
        attachments: 0,
        storing: Promise.resolve([]),
      };
      (session.queue ??= []).push(entry);
      this.broadcastQueue(session);
      return;
    }
    if (!this.sessions.has(sessionId)) return;
    void this.prompt(sessionId, text)
      .catch((error: unknown) =>
        console.error(`[${session.providerId}] returned prompt failed:`, error),
      )
      .finally(() => this.send({ t: "session.idle", sessionId, ...this.sessionOrigin(sessionId) }));
  }

  /** Everything queued, as the next turn; undefined when nothing is waiting. */
  protected async takeQueuedTurn(session: ActiveSession) {
    const entries = session.queue?.splice(0) ?? [];
    if (entries.length === 0) return undefined;
    // Bounded: only the latest turn-end notification can still name these.
    session.sentForwarded = entries.filter((entry) => entry.forwarded);
    this.broadcastQueue(session);
    const texts: { text: string; stored: StoredAttachment[] }[] = [];
    for (const entry of entries) texts.push({ text: entry.text, stored: await entry.storing });
    return { texts };
  }

  /** Clear the queue unsent and hand it back to the composer. */
  protected returnQueue(session: ActiveSession) {
    const returned = session.queue?.splice(0) ?? [];
    if (returned.length > 0) this.broadcastQueue(session, returned);
  }

  /** Full queue state to every client. Broadcast, never logged. */
  protected broadcastQueue(session: ActiveSession, returned?: QueueEntry[]) {
    if (!session.live) return;
    const message: wire.SessionQueue = {
      t: "session.queue",
      sessionId: session.log.sessionId,
      queued: (session.queue ?? []).map(queuedForWire),
      ...(returned ? { returned: returned.map(queuedForWire) } : {}),
    };
    this.send(message);
  }

  /** Withdraw one queued message. False when it was already gone or the agent had taken it. */
  async cancelQueued(sessionId: string, id: string): Promise<boolean> {
    const session = this.require(sessionId);
    const entry = session.queue?.find((queued) => queued.id === id);
    if (!entry) {
      // Re-sync whoever asked: their strip is showing something stale.
      this.broadcastQueue(session);
      return false;
    }
    const handle = session.handle;
    if (entry.agentId && handle) {
      try {
        const answer = await handle.extRequest<{ cancelled?: unknown }>("_gg/queue/cancel", {
          sessionId: handle.sessionId,
          id: entry.agentId,
        });
        // The agent already folded it in; its `drained` logs it as a turn.
        if (answer?.cancelled === false) return false;
      } catch {
        // The agent no longer has it; ours is the copy that would be sent.
      }
    }
    if (!session.queue?.includes(entry)) return false;
    session.queue = session.queue.filter((queued) => queued !== entry);
    this.broadcastQueue(session);
    return true;
  }
}
