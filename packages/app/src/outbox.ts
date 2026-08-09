/**
 * Messages typed while the phone had no way to send them.
 *
 * The socket is the only route to the agent, and it is down more often than
 * anything else in this system: a lift, a tunnel, a train, a phone that slept.
 * Until this module existed those minutes were a hard lock — the composer was
 * disabled outright, and the one path that did write to a dead socket (a prompt
 * into an open conversation) rendered the message, started the spinner and
 * silently dropped it, because `post` returns false and nothing read the answer.
 *
 * So a send that cannot go out is held here instead of refused or lost, and the
 * socket coming back is what delivers it. That is also the useful half of the
 * feature: thinking of three things to ask while offline and having all three
 * run the moment there is signal again.
 *
 * Pure and React-free so the ordering, the caps and the re-addressing rules are
 * directly testable — `useDaemon` owns only the sockets and the state.
 */
import { isPendingSession, pendingSessionKey } from "./pendingSession";
import type { WireAttachment } from "./attachments";
import type { Turn } from "./useDaemon";

/**
 * A prompt waiting for a socket.
 *
 * `turnKey` is the optimistic turn already on screen (see `localTurn`), so
 * delivering this entry can find the bubble it belongs to and stop calling it
 * queued. It is the turn's `key`, not its `id`: the id is swapped for the
 * daemon's when the echo arrives, and the key is the one that never changes.
 */
export interface QueuedPrompt {
  kind: "prompt";
  turnKey: string;
  /**
   * Where it goes. May be a `pending:` key while the conversation carrying it
   * has itself not been created yet — `remapSession` re-addresses it once the
   * daemon names the session.
   */
  sessionId: string;
  text: string;
  attachments: WireAttachment[];
}

/**
 * A conversation asked for while offline.
 *
 * Only the request. Its first message is queued separately, as a prompt against
 * the `pending:` key this request will be renamed from — not in the `queued`
 * slot `session.started` normally delivers from, because that slot is only sent
 * when the answer lands on the conversation the user is looking at. Online that
 * is a moment later; across a reconnect it is however long the tunnel lasted,
 * and a user who has since opened another conversation would have watched their
 * first message be adopted into the new row and then never sent.
 */
export interface QueuedStart {
  kind: "start";
  requestId: string;
  providerId: string;
  cwd?: string;
}

export type OutboxEntry = QueuedPrompt | QueuedStart;

/**
 * How many messages may wait at once.
 *
 * Generous for the case this exists for — a handful of things thought of on the
 * Underground — and still a bound, because the queue holds attachment bytes and
 * lives in the memory of the most constrained device in the system. A refusal
 * is visible (the draft stays in the composer) where an eviction would not be:
 * dropping the oldest would silently destroy the message the user has been
 * waiting longest to send.
 */
export const MAX_QUEUED = 25;

/**
 * How many bytes of attachments may wait at once.
 *
 * Photos are held base64-encoded, which is where the real memory goes: the
 * daemon caps one image at 8MB, so a few of those queued together is the
 * difference between a queue and a crash. Text is not counted — a prompt is
 * kilobytes at worst.
 */
export const MAX_QUEUED_BYTES = 24 * 1024 * 1024;

/**
 * The conversation an entry is addressed to, pending or live.
 *
 * A start is addressed to the `pending:` row it created, because that row is
 * what holds its first message until `session.started` renames both.
 */
export function outboxSession(entry: OutboxEntry): string {
  return entry.kind === "prompt" ? entry.sessionId : pendingSessionKey(entry.requestId);
}

function queuedBytes(queue: readonly OutboxEntry[]): number {
  let total = 0;
  for (const entry of queue) {
    if (entry.kind !== "prompt") continue;
    for (const file of entry.attachments) total += file.data.length;
  }
  return total;
}

/**
 * Add one message to the back of the queue.
 *
 * Returns undefined when it will not fit, which the caller reports as a refused
 * send — the words stay in the composer rather than joining a queue that cannot
 * promise to deliver them.
 */
export function enqueue(
  queue: readonly OutboxEntry[],
  entry: OutboxEntry,
): OutboxEntry[] | undefined {
  if (queue.length >= MAX_QUEUED) return undefined;
  if (entry.kind === "prompt") {
    const adding = entry.attachments.reduce((total, file) => total + file.data.length, 0);
    if (queuedBytes(queue) + adding > MAX_QUEUED_BYTES) return undefined;
  }
  return [...queue, entry];
}

/**
 * Re-address everything queued for one conversation to another.
 *
 * Two things rename a conversation under a waiting prompt, and both would
 * otherwise deliver it to a session id the daemon has never heard of:
 *
 * - `session.started` answering a `pending:` request with a real id, which is
 *   how a second message sent while the first was still starting is delivered.
 * - a resume, when the daemon restarted and minted a new id for a conversation
 *   the agent still holds on disk. The prompt was queued against the old row.
 *
 * Order is preserved: these are messages in a conversation, and delivering the
 * second one first would read as the user having said them backwards.
 */
export function remapSession(
  queue: readonly OutboxEntry[],
  from: string,
  to: string,
): OutboxEntry[] {
  if (from === to) return queue as OutboxEntry[];
  let changed = false;
  const next = queue.map((entry) => {
    if (entry.kind !== "prompt" || entry.sessionId !== from) return entry;
    changed = true;
    return { ...entry, sessionId: to };
  });
  return changed ? next : (queue as OutboxEntry[]);
}

/**
 * Split the queue into what can go now and what must keep waiting.
 *
 * Holding rather than dropping is deliberate: a prompt addressed to a
 * conversation the daemon no longer holds is not undeliverable, it is early.
 * Opening that conversation resumes it, and `remapSession` then points this
 * entry at the session the agent came back as.
 */
export function partitionOutbox(
  queue: readonly OutboxEntry[],
  deliverable: (entry: OutboxEntry) => boolean,
): { ready: OutboxEntry[]; held: OutboxEntry[] } {
  const ready: OutboxEntry[] = [];
  const held: OutboxEntry[] = [];
  for (const entry of queue) (deliverable(entry) ? ready : held).push(entry);
  return { ready, held };
}

/**
 * The `pending:` rows that must survive a reconnect.
 *
 * `dropPendingSessions` clears requests written to a socket that then died,
 * because their answer was broadcast once into the void. A request that never
 * reached a socket at all is the opposite case: it is still going to be sent,
 * it carries the user's first prompt, and dropping its row would take the only
 * thing on screen pointing at that message with it.
 */
export function queuedPendingSessions(queue: readonly OutboxEntry[]): Set<string> {
  const keys = new Set<string>();
  for (const entry of queue) {
    const id = outboxSession(entry);
    if (isPendingSession(id)) keys.add(id);
  }
  return keys;
}

/**
 * The conversation a new message should join rather than start.
 *
 * A conversation is only created by its first prompt, so between "send" and
 * `session.started` there is no session id — and the screen's next send would
 * therefore start a *second* conversation. Offline that is the normal case
 * rather than a race: every message typed in a tunnel would open its own empty
 * thread, and each one would spawn an agent when signal returned.
 *
 * So a start already waiting adopts the messages typed after it. Restricted to
 * the same agent, because choosing a different one in the drawer is a request
 * for a different conversation.
 */
export function pendingStartFor(
  queue: readonly OutboxEntry[],
  providerId: string,
): QueuedStart | undefined {
  return queue.find(
    (entry): entry is QueuedStart => entry.kind === "start" && entry.providerId === providerId,
  );
}

/**
 * Take the waiting mark off the turns that have just gone out.
 *
 * Matched by `key`, not `id`: the id is swapped for the daemon's the moment the
 * echo arrives, and the echo can land before this runs.
 *
 * Returns the same array when nothing changed, and that identity is load
 * bearing rather than a render optimisation — it is how the caller knows which
 * conversation these messages were in. A queued prompt's row may still be a
 * `pending:` request about to be renamed by `session.started`, so "does this
 * transcript hold one of the turns" is a question that survives the rename,
 * where "does this id match" does not.
 */
export function markSent(turns: Turn[], keys: ReadonlySet<string>): Turn[] {
  if (keys.size === 0) return turns;
  let changed = false;
  const next = turns.map((turn) => {
    if (!turn.queued || !turn.key || !keys.has(turn.key)) return turn;
    changed = true;
    const { queued: _queued, ...rest } = turn;
    return rest;
  });
  return changed ? next : turns;
}
