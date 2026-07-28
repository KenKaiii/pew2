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
 */
import type { wire } from "@pew2/protocol";

export class SessionLog {
  readonly sessionId: string;
  private readonly entries: wire.SessionEvent[] = [];
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
    return event;
  }

  /** Events strictly newer than `cursor`. Pass -1 for the full history. */
  since(cursor: number): wire.SessionEvent[] {
    return this.entries.filter((e) => e.seq > cursor);
  }

  get events(): readonly wire.SessionEvent[] {
    return this.entries;
  }

  get latestSeq(): number {
    return this.nextSeq - 1;
  }
}
