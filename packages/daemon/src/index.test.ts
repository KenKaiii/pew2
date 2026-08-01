/**
 * Daemon behaviour that only shows up in ordering.
 *
 * **Session liveness.** A resumed agent replays its history *during*
 * `session/load`, before the handler can announce the session. Clients drop
 * events for sessions they have not been told about, so those early events must
 * be held in the log and flushed only after `session.started` — the bug this
 * guards rendered every resumed GG Coder conversation empty on the phone.
 *
 * **Config preferences.** A model or mode is a property of a session, but the
 * user picks one in the empty state, where no session exists yet. The choice is
 * therefore stored against the provider and applied when the session opens.
 */
import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Daemon } from "./index.js";
import { SessionLog } from "./session/log.js";
import { readConfigPrefs, writeConfigPref } from "./config-prefs.js";
import { withStoredPrefs } from "./index.js";
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
    providerId: "test",
    live: false,
  };
  (daemon as any).sessions.set(sessionId, session);
  return session;
}

test("a selector chosen before any session exists is kept for the next one", async () => {
  // The empty state offers the same pills a live conversation does, but a
  // session only exists once the first prompt is sent — so this path is the
  // difference between the choice sticking and being silently dropped.
  const { daemon } = daemonWithCollector();
  const home = process.env.PEW2_HOME;
  process.env.PEW2_HOME = await mkdtemp(join(tmpdir(), "pew2-prefs-early-"));
  try {
    await daemon.rememberConfigOption("claude-code", "__acp_mode", "plan");

    expect(await readConfigPrefs("claude-code")).toEqual({ __acp_mode: "plan" });
  } finally {
    if (home === undefined) delete process.env.PEW2_HOME;
    else process.env.PEW2_HOME = home;
  }
});

test("a remembered selector is restored, and only where it applies", async () => {
  const { daemon } = daemonWithCollector();
  const session = plantSession(daemon, "prefs");
  const applied: [string, string | boolean][] = [];

  session.handle = {
    configOptions: [
      { id: "__acp_model", name: "Model", type: "select", currentValue: "sonnet" },
      { id: "effort", name: "Effort", type: "select", currentValue: "high" },
    ],
    setConfigOption: async (configId: string, value: string | boolean) => {
      applied.push([configId, value]);
      return [];
    },
  } as unknown as AcpSessionHandle;

  const home = process.env.PEW2_HOME;
  process.env.PEW2_HOME = await mkdtemp(join(tmpdir(), "pew2-prefs-restore-"));
  try {
    await writeConfigPref("test", "__acp_model", "opus");
    // Already this session's value: re-sending it is a round trip for nothing.
    await writeConfigPref("test", "effort", "high");
    // An option this agent version no longer advertises is skipped rather than
    // sent — a stale preference must never fail a session.
    await writeConfigPref("test", "gone", "whatever");

    await (daemon as any).applyConfigPrefs(session, "test");

    expect(applied).toEqual([["__acp_model", "opus"]]);
  } finally {
    if (home === undefined) delete process.env.PEW2_HOME;
    else process.env.PEW2_HOME = home;
  }
});

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

test("a probe reports the remembered value, not the agent's default", () => {
  // The pills read this before any session exists. Reporting the agent's own
  // default here is what showed "Default" until the first prompt landed.
  const options = [
    {
      id: "__acp_model",
      name: "Model",
      type: "select" as const,
      currentValue: "sonnet",
      options: [
        { value: "sonnet", name: "Sonnet" },
        { value: "opus", name: "Opus" },
      ],
    },
  ];

  expect(withStoredPrefs(options, { __acp_model: "opus" })[0]?.currentValue).toBe("opus");
});

test("a preference the agent no longer offers is ignored", () => {
  // Otherwise a pill would name a model that cannot be selected.
  const options = [
    {
      id: "__acp_model",
      name: "Model",
      type: "select" as const,
      currentValue: "sonnet",
      options: [{ value: "sonnet", name: "Sonnet" }],
    },
  ];

  expect(withStoredPrefs(options, { __acp_model: "gone" })[0]?.currentValue).toBe("sonnet");
});
