/**
 * Append-only, sequence-numbered event log for one session.
 *
 * This is the mechanism that makes phone and desktop show the same conversation.
 * ACP itself will not do this for us: `session/load` replays history when a
 * session is opened, but ACP v1 does not replay in-flight transport messages
 * emitted while a client was disconnected. So the daemon records every update
 * with a gapless `seq`, and a reconnecting client asks for everything after the
 * highest `seq` it already has.
 *
 * Deliberately append-only rather than a CRDT: there is exactly one writer (the
 * daemon), so ordering is unambiguous and no merge logic is needed.
 *
 * Append-only, but not unbounded. Sessions live for as long as the daemon does,
 * and a streamed reply arrives as hundreds of small chunks: 20,000 of them
 * measure 3.8MB, so a handful of long conversations is tens of megabytes that
 * are never freed. The oldest events are dropped once the log is full \u2014 they
 * have long since been delivered, and anything older than the window is
 * recovered by reopening the conversation, which replays from the agent.
 */
import type { wire } from "@pew2/protocol";

/**
 * How many events one session keeps in memory.
 *
 * Sized for the job it does: catching up a phone that dropped off mid-reply.
 * A long agent turn is a few thousand chunks, so this holds several turns while
 * capping a session at roughly two megabytes.
 */
const MAX_EVENTS = 10_000;

export class SessionLog {
  readonly sessionId: string;
  private entries: wire.SessionEvent[] = [];
  private nextSeq = 0;

  constructor(sessionId: string) {
    this.sessionId = sessionId;
  }

  append(payload: unknown): wire.SessionEvent {
    const event: wire.SessionEvent = {
      t: "session.event",
      sessionId: this.sessionId,
      seq: this.nextSeq++,
      at: Date.now(),
      payload,
    };
    this.entries.push(event);
    // Trimmed in blocks rather than one at a time: `shift()` on every append is
    // O(n) per call, and this runs on every chunk of every reply.
    if (this.entries.length > MAX_EVENTS + 1000) {
      this.entries = this.entries.slice(-MAX_EVENTS);
    }
    return event;
  }

  /**
   * Events strictly newer than `cursor`. Pass -1 for everything still held.
   *
   * `seq` is gapless and the array is ordered, so the first matching index can
   * be found by search rather than by testing every event \u2014 this is called on
   * each reconnect, against a log that can hold ten thousand of them.
   */
  since(cursor: number): wire.SessionEvent[] {
    let low = 0;
    let high = this.entries.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (this.entries[mid]!.seq > cursor) high = mid;
      else low = mid + 1;
    }
    return this.entries.slice(low);
  }

  get events(): readonly wire.SessionEvent[] {
    return this.entries;
  }

  get latestSeq(): number {
    return this.nextSeq - 1;
  }
}
