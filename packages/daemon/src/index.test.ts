/**
 * Session liveness ordering.
 *
 * A resumed agent replays its history *during* `session/load`, before the
 * handler can announce the session. Clients drop events for sessions they have
 * not been told about, so those early events must be held in the log and
 * flushed only after `session.started` — the bug this regression test guards
 * rendered every resumed GG Coder conversation empty on the phone.
 */
import { test, expect } from "bun:test";
import { Daemon } from "./index.js";
import { SessionLog } from "./session/log.js";
import type { AcpSessionHandle } from "./acp/connect.js";

function daemonWithCollector() {
  const sent: unknown[] = [];
  const daemon = new Daemon({ id: "test", name: "test" });
  daemon.attach((message) => sent.push(message));
  return { daemon, sent };
}

/** Register a session without spawning an agent: the mechanism is what matters. */
function plantSession(daemon: Daemon, sessionId: string) {
  const session = {
    handle: {} as AcpSessionHandle,
    log: new SessionLog(sessionId),
    live: false,
  };
  (daemon as any).sessions.set(sessionId, session);
  return session;
}

test("events are held until the session is live, then flushed as one replay", () => {
  const { daemon, sent } = daemonWithCollector();
  const session = plantSession(daemon, "s1");

  // What `session/load` does: a burst of history before anyone can announce.
  (daemon as any).record(session, { n: 1 });
  (daemon as any).record(session, { n: 2 });
  expect(sent).toHaveLength(0);

  // seqs kept stamping while held back, so the flush is complete and ordered.
  expect(session.log.events.map((e) => e.seq)).toEqual([0, 1]);

  daemon.markLive("s1");
  // The backlog ships as one replay frame, in seq order: the app folds it into
  // a single render rather than one update per event.
  expect(sent).toHaveLength(1);
  const replay = sent[0] as any;
  expect(replay.t).toBe("session.replay");
  expect(replay.events.map((e: any) => e.payload.n)).toEqual([1, 2]);

  // Once live, new events go straight out individually.
  (daemon as any).record(session, { n: 3 });
  expect(sent).toHaveLength(2);
  expect((sent[1] as any).payload.n).toBe(3);
});

test("markLive is idempotent and ignores unknown sessions", () => {
  const { daemon, sent } = daemonWithCollector();
  const session = plantSession(daemon, "s1");
  (daemon as any).record(session, { n: 1 });

  daemon.markLive("does-not-exist");
  expect(sent).toHaveLength(0);

  daemon.markLive("s1");
  daemon.markLive("s1");
  // Flushing twice would duplicate the whole history on every client.
  expect(sent).toHaveLength(1);
});

test("an empty replay still marks transcript loading complete", () => {
  const { daemon, sent } = daemonWithCollector();
  plantSession(daemon, "empty");

  daemon.markLive("empty");

  expect(sent).toEqual([{ t: "session.replay", sessionId: "empty", events: [] }]);
});

test("resume history streams after announcement and ends with a completion frame", async () => {
  const { daemon, sent } = daemonWithCollector();
  const session = plantSession(daemon, "streaming");

  daemon.markStreaming("streaming");
  (daemon as any).record(session, { n: 1 });
  (daemon as any).record(session, { n: 2 });
  await new Promise((resolve) => setTimeout(resolve, 25));

  expect(sent).toHaveLength(1);
  expect(sent[0]).toMatchObject({
    t: "session.replay",
    sessionId: "streaming",
    complete: false,
  });
  expect((sent[0] as any).events.map((event: any) => event.payload.n)).toEqual([1, 2]);

  daemon.finishStreaming("streaming");
  expect(sent[1]).toEqual({
    t: "session.replay",
    sessionId: "streaming",
    events: [],
    complete: true,
  });
});
