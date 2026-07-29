/**
 * Reconnect cursors: "I already have up to seq N for this session."
 *
 * ACP does not replay messages emitted while a client was disconnected, so the
 * daemon and relay keep the log and hand back everything after the cursor. On a
 * phone this is not an edge case — the socket dies every time the app is
 * backgrounded or the network changes — and without a cursor the tail of every
 * interrupted turn is lost silently.
 *
 * Kept pure and separate from the socket so the rule that actually matters can
 * be tested: the cursor only ever moves forward.
 */

export type Cursors = Record<string, number>;

/**
 * Record a seen event. Returns the same object when nothing changed, so callers
 * can skip work cheaply.
 *
 * Out-of-order and duplicate events must not rewind the cursor: replayed
 * history arrives interleaved with live events, and a rewind would re-request
 * everything already on screen.
 */
export function advance(cursors: Cursors, sessionId: string, seq: number): Cursors {
  if (!Number.isInteger(seq) || seq < 0) return cursors;
  const seen = cursors[sessionId];
  if (seen !== undefined && seq <= seen) return cursors;
  return { ...cursors, [sessionId]: seq };
}

/**
 * Whether an event has already been applied.
 *
 * Replay and the live stream can overlap — the relay may send an event the
 * client received just before the socket dropped — so the renderer needs to
 * recognise a duplicate rather than showing the same output twice.
 */
export function alreadySeen(cursors: Cursors, sessionId: string, seq: number): boolean {
  const seen = cursors[sessionId];
  return seen !== undefined && seq <= seen;
}
