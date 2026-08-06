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
import { readSessionPrefs, writeSessionPrefs } from "./session-prefs.js";
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

test("the provider announcement names the sessions this process still holds", () => {
  // Session ids are assigned per daemon process and die with it, while the
  // app's session list survives restarts and reconnects. Without this the app
  // prompts an id from a previous process and gets "Unknown session" — so the
  // announcement (which `hello` triggers) is what tells it to reopen instead.
  const { daemon, sent } = daemonWithCollector();
  plantSession(daemon, "alive-1");
  plantSession(daemon, "alive-2");

  (daemon as any).announceProviders();

  const announce: any = sent.findLast((m: any) => m.t === "providers");
  expect(announce.activeSessions).toEqual(["alive-1", "alive-2"]);

  // A closed session drops out, which is the whole signal: the app must not go
  // on prompting an id the daemon no longer has.
  (daemon as any).sessions.delete("alive-1");
  (daemon as any).announceProviders();
  expect((sent.findLast((m: any) => m.t === "providers") as any).activeSessions).toEqual([
    "alive-2",
  ]);
});

test("reopening a conversation restores the model it was last held at", async () => {
  // `session/load` replays the transcript but hands back the agent's *default*
  // selectors, so without a per-conversation record, leaving a session and
  // coming back silently reverted the model that was picked in it.
  const { daemon } = daemonWithCollector();
  const session = plantSession(daemon, "resumed");
  const applied: [string, string | boolean][] = [];

  session.handle = {
    sessionId: "agent-1",
    configOptions: [
      {
        id: "__acp_model",
        name: "Model",
        type: "select",
        currentValue: "opus-5",
        options: [{ value: "opus-5", name: "Opus" }, { value: "sonnet", name: "Sonnet" }],
      },
    ],
    setConfigOption: async (configId: string, value: string | boolean) => {
      applied.push([configId, value]);
      return [];
    },
  } as unknown as AcpSessionHandle;

  const home = process.env.PEW2_HOME;
  process.env.PEW2_HOME = await mkdtemp(join(tmpdir(), "pew2-prefs-session-"));
  try {
    // The provider-wide preference is deliberately something else: a resumed
    // conversation must not be rewritten to match whatever the phone last
    // picked in the empty state.
    await writeConfigPref("test", "__acp_model", "haiku");
    await writeSessionPrefs("test", "agent-1", { __acp_model: "sonnet" });

    const restored = await (daemon as any).applySessionPrefs(session, "test", "agent-1");

    expect(applied).toEqual([["__acp_model", "sonnet"]]);
    expect(restored).toEqual({ __acp_model: "sonnet" });
  } finally {
    if (home === undefined) delete process.env.PEW2_HOME;
    else process.env.PEW2_HOME = home;
  }
});

test("a conversation never configured here keeps the agent's own settings", async () => {
  // Work started at the desk belongs to the desk: with nothing recorded against
  // it, the agent's answer is the honest one and the provider default is not.
  const { daemon } = daemonWithCollector();
  const session = plantSession(daemon, "untouched");
  const applied: string[] = [];

  session.handle = {
    sessionId: "agent-2",
    configOptions: [
      { id: "__acp_model", name: "Model", type: "select", currentValue: "opus-5" },
    ],
    setConfigOption: async (configId: string) => {
      applied.push(configId);
      return [];
    },
  } as unknown as AcpSessionHandle;

  const home = process.env.PEW2_HOME;
  process.env.PEW2_HOME = await mkdtemp(join(tmpdir(), "pew2-prefs-untouched-"));
  try {
    await writeConfigPref("test", "__acp_model", "haiku");

    expect(await (daemon as any).applySessionPrefs(session, "test", "agent-2")).toEqual({});
    expect(applied).toEqual([]);
  } finally {
    if (home === undefined) delete process.env.PEW2_HOME;
    else process.env.PEW2_HOME = home;
  }
});

test("a selector set on a session is remembered against that conversation", async () => {
  const { daemon } = daemonWithCollector();
  const session = plantSession(daemon, "live") as any;
  session.ready = Promise.resolve();
  session.agentSessionId = "agent-3";
  session.handle = {
    sessionId: "agent-3",
    configOptions: [],
    setConfigOption: async () => [],
  } as unknown as AcpSessionHandle;

  const home = process.env.PEW2_HOME;
  process.env.PEW2_HOME = await mkdtemp(join(tmpdir(), "pew2-prefs-set-"));
  try {
    await daemon.setConfigOption("live", "__acp_model", "sonnet");
    // Written in the background, deliberately: the reply must not wait on disk.
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Both records: the provider one seeds the *next* new conversation, the
    // session one survives leaving this conversation and coming back.
    expect(await readConfigPrefs("test")).toEqual({ __acp_model: "sonnet" });
    expect(await readSessionPrefs("test", "agent-3")).toEqual({ __acp_model: "sonnet" });
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

test("a selector the agent changes by itself reaches the app", async () => {
  // The option set is model-dependent: Claude Code advertises a thinking-level
  // selector only while a model that supports one is current, and announces its
  // arrival with a `config_option_update` notification rather than in a reply.
  // Dropped, the pills went on describing whatever was current when the session
  // opened — "I switched model and the thinking option never appeared".
  const { daemon, sent } = daemonWithCollector();
  // Named, so a write to `session-prefs.json` would have a key to land under.
  const session: any = plantSession(daemon, "live-config");
  session.agentSessionId = "agent-live";
  const effort = [{ id: "effort", name: "Effort", type: "select", currentValue: "high" }];

  // Redirected like every other prefs test: the assertion below is about what
  // was written, so it must not read — or risk writing — the real `~/.pew2`.
  const home = process.env.PEW2_HOME;
  process.env.PEW2_HOME = await mkdtemp(join(tmpdir(), "pew2-live-config-"));
  try {
    // Not yet announced: a client drops events for a session it has never been
    // told about, so this would be shouted into the void.
    (daemon as any).publishConfigOptions(session, effort);
    expect(sent.filter((m: any) => m.t === "session.config")).toEqual([]);

    session.live = true;
    (daemon as any).publishConfigOptions(session, effort);

    const config: any = sent.findLast((m: any) => m.t === "session.config");
    expect(config.sessionId).toBe("live-config");
    expect(config.configOptions).toEqual(effort);

    // Nothing is recorded against the conversation, unlike an explicit change.
    // `session-prefs.json` replays a *user's* choices over the defaults a
    // resumed session comes back with, so writing the agent's own state here
    // would give a conversation that was never configured a full record — later
    // replayed over whatever it was since changed to at the desk.
    expect(await readSessionPrefs("test", "agent-live")).toEqual({});
  } finally {
    if (home === undefined) delete process.env.PEW2_HOME;
    else process.env.PEW2_HOME = home;
  }
});

test("a prompt's attachments are written to disk and echoed as paths", async () => {
  // The echo is what every *other* client sees — and what this one sees after a
  // reconnect, since the optimistic turn's copy is local to the sending phone.
  const { daemon, sent } = daemonWithCollector();
  const session = plantSession(daemon, "s1");
  daemon.markLive("s1");

  const prompted: unknown[] = [];
  session.handle = {
    prompt: (text: string, attachments: unknown) => {
      prompted.push({ text, attachments });
      return Promise.resolve();
    },
  } as unknown as AcpSessionHandle;
  (daemon as any).sessions.get("s1").ready = Promise.resolve();

  await daemon.prompt("s1", "look", [
    { name: "shot.png", mimeType: "image/png", data: Buffer.from("PNG").toString("base64") },
  ]);

  const echo = sent.map((m: any) => m.payload).find((p: any) => p?.kind === "user_message");
  expect(echo.attachments).toHaveLength(1);
  expect(echo.attachments[0]).toMatchObject({ name: "shot.png", mimeType: "image/png" });
  // A real path on this machine, which `image.fetch` can then serve.
  expect(echo.attachments[0].uri).toContain("pew2-attachments");
  expect(await Bun.file(echo.attachments[0].uri).text()).toBe("PNG");

  // The agent is handed the stored form, not the raw wire payload.
  expect((prompted[0] as any).attachments[0].path).toBe(echo.attachments[0].uri);
});

test("an ordinary text prompt carries no attachments key at all", async () => {
  // Nearly every turn. An empty array on each one would bloat the log and every
  // replayed frame for a feature that was not used.
  const { daemon, sent } = daemonWithCollector();
  const session = plantSession(daemon, "s1");
  daemon.markLive("s1");
  session.handle = { prompt: () => Promise.resolve() } as unknown as AcpSessionHandle;
  (daemon as any).sessions.get("s1").ready = Promise.resolve();

  await daemon.prompt("s1", "just words");

  const echo = sent.map((m: any) => m.payload).find((p: any) => p?.kind === "user_message");
  expect(echo).toEqual({ kind: "user_message", text: "just words" });
});

test("a prompt over the attachment limits is refused before anything is echoed", async () => {
  // A turn on every screen referring to a file the agent never received is
  // worse than a failed send.
  const { daemon, sent } = daemonWithCollector();
  const session = plantSession(daemon, "s1");
  daemon.markLive("s1");
  session.handle = { prompt: () => Promise.resolve() } as unknown as AcpSessionHandle;
  (daemon as any).sessions.get("s1").ready = Promise.resolve();

  await expect(
    daemon.prompt("s1", "look", [
      { name: "huge.bin", mimeType: "application/octet-stream", data: "A".repeat(12 * 1024 * 1024) },
    ]),
  ).rejects.toThrow(/limit/);

  expect(sent.map((m: any) => m.payload).some((p: any) => p?.kind === "user_message")).toBe(false);
});

test("an agent that is not installed is never announced to the phone", () => {
  // A dimmed row for an agent that is not on the machine is furniture that can
  // never become useful: you cannot install a CLI from a phone. It also made the
  // phone disagree with `pew2 setup`, whose picker will not let these be chosen
  // — so the app offered agents the user was never given a choice about.
  //
  // An agent that is installed but still needs a key is a different case and is
  // announced: it really is here, and the reason says what to do on the desktop.
  const { daemon, sent } = daemonWithCollector();
  (daemon as any).providers = [
    {
      manifest: { id: "here", name: "Here", pew: { transport: "acp" } },
      commandMissing: false,
      missingEnv: [],
    },
    {
      manifest: { id: "needs-key", name: "Needs Key", pew: { transport: "acp" } },
      commandMissing: false,
      missingEnv: ["SOME_KEY"],
    },
    {
      manifest: { id: "absent", name: "Absent", pew: { transport: "acp" } },
      commandMissing: true,
      missingEnv: [],
    },
  ];

  (daemon as any).announceProviders();

  const announce: any = sent.findLast((m: any) => m.t === "providers");
  const ids = announce.providers.map((p: any) => p.id);
  expect(ids).toEqual(["here", "needs-key"]);
  expect(ids).not.toContain("absent");
});

/** A session as the reaper sees it: a closable handle and a last-used clock. */
function plantIdleSession(
  daemon: Daemon,
  sessionId: string,
  overrides: Record<string, unknown> = {},
) {
  let closed = false;
  const session = {
    handle: { close: () => { closed = true; } } as unknown as AcpSessionHandle,
    log: new SessionLog(sessionId),
    providerId: "test",
    cwd: "/tmp",
    live: true,
    ready: Promise.resolve(),
    agentSessionId: `agent-${sessionId}`,
    lastUsedAt: 0,
    ...overrides,
  };
  (daemon as any).sessions.set(sessionId, session);
  return { session, wasClosed: () => closed };
}

test("a conversation nobody has touched in hours gives its agent back", () => {
  // Nothing ended a session before this. Every conversation opened held a whole
  // agent process until the daemon died — measured on a real machine as eleven
  // GG Coder processes and 2.2GB, for chats finished hours earlier.
  const { daemon } = daemonWithCollector();
  const old = plantIdleSession(daemon, "stale");

  const reaped = daemon.reapIdleSessions(2 * 60 * 60 * 1000);

  expect(reaped).toEqual(["stale"]);
  expect(old.wasClosed()).toBe(true);
  // Gone from the map as well as closed: a session whose process is dead must
  // not stay listed as one a client can prompt.
  expect((daemon as any).sessions.has("stale")).toBe(false);
});

test("a turn still running is never reaped, however quiet it has gone", () => {
  // The dangerous case. An agent can spend minutes inside a single tool call
  // without emitting anything, so elapsed silence is not evidence of idleness —
  // and closing the process there would lose an answer the user is waiting for.
  const { daemon } = daemonWithCollector();
  const working = plantIdleSession(daemon, "working", { working: true });

  expect(daemon.reapIdleSessions(2 * 60 * 60 * 1000)).toEqual([]);
  expect(working.wasClosed()).toBe(false);
});

test("a conversation used recently is left alone", () => {
  const { daemon } = daemonWithCollector();
  const fresh = plantIdleSession(daemon, "fresh", { lastUsedAt: 60 * 60 * 1000 });

  // Ten minutes later: well inside the window.
  expect(daemon.reapIdleSessions(60 * 60 * 1000 + 10 * 60 * 1000)).toEqual([]);
  expect(fresh.wasClosed()).toBe(false);
});

test("a session with nothing to resume from is kept, not closed", () => {
  // Closing one of these would lose the conversation rather than park it: with
  // no agent session id there is nothing to reopen from. They are rare and
  // short-lived, since the id arrives during the handshake.
  const { daemon } = daemonWithCollector();
  const unnamed = plantIdleSession(daemon, "unnamed", { agentSessionId: undefined });

  expect(daemon.reapIdleSessions(2 * 60 * 60 * 1000)).toEqual([]);
  expect(unnamed.wasClosed()).toBe(false);
});

test("reaping tells clients, through the list they already watch", () => {
  // Deliberately the ordinary `providers` announce rather than a new message:
  // its `activeSessions` is the set this process still holds, and the app
  // already resumes a conversation whose id has left that list — which is how
  // it survives a daemon restart. An app already on TestFlight handles this.
  const { daemon, sent } = daemonWithCollector();
  plantIdleSession(daemon, "stale");
  sent.length = 0;

  daemon.reapIdleSessions(2 * 60 * 60 * 1000);

  const announce = sent.find((m: any) => m?.t === "providers") as any;
  expect(announce).toBeDefined();
  expect(announce.activeSessions).not.toContain("stale");
});

test("a pass that reaps nothing says nothing", () => {
  // The reaper runs every few minutes forever. Announcing each time would put a
  // full provider list on the wire for no reason, and re-render the drawer.
  const { daemon, sent } = daemonWithCollector();
  plantIdleSession(daemon, "fresh", { lastUsedAt: 60 * 60 * 1000 });
  sent.length = 0;

  daemon.reapIdleSessions(60 * 60 * 1000);

  expect(sent).toEqual([]);
});

test("a prompt that throws does not strand the session as working for ever", async () => {
  // `working` makes a session un-reapable, so every path out of a prompt must
  // clear it. A turn can fail before the agent is even reached — an attachment
  // over the size limit, a disk with nothing left — and if that escaped the
  // guard the session stayed marked working permanently and the reaper could
  // never touch it again. A permanent leak, created by the flag added to stop
  // one.
  const { daemon } = daemonWithCollector();
  // A handle whose `prompt` rejects: the same shape as any turn that fails.
  const { session } = plantIdleSession(daemon, "failed", {
    handle: {
      close: () => {},
      prompt: () => Promise.reject(new Error("disk full")),
    } as unknown as AcpSessionHandle,
  });

  await expect(daemon.prompt("failed", "hello")).rejects.toThrow("disk full");

  expect((session as any).working).toBe(false);
  // And is genuinely reapable again, which is the property that actually
  // matters — the flag is only interesting through the reaper.
  (session as any).lastUsedAt = 0;
  expect(daemon.reapIdleSessions(2 * 60 * 60 * 1000)).toEqual(["failed"]);
});

test("opening conversations in a burst does not hold all of them", () => {
  // The hole the time limit alone leaves. Someone working through a morning — a
  // task here, a new one in another project, a third to check something — opens
  // conversations far faster than a one-hour clock retires them, and ten live
  // agents is roughly two gigabytes. The TTL bounds lingering; only a cap bounds
  // the burst.
  const { daemon } = daemonWithCollector();
  const opened = [1, 2, 3, 4, 5].map((n) =>
    plantIdleSession(daemon, `s${n}`, { lastUsedAt: n * 1000 }),
  );

  // A sixth arrives, the way a real one does.
  plantIdleSession(daemon, "new", { lastUsedAt: 9_000 });
  (daemon as any).enforceSessionCap("new");

  // Four live agents plus the one being opened.
  expect((daemon as any).sessions.size).toBe(4);
  // Least recently *used* went first, not oldest-opened: a conversation started
  // this morning and still worked in outranks one opened ten minutes ago and
  // abandoned.
  expect(opened[0]!.wasClosed()).toBe(true);
  expect(opened[1]!.wasClosed()).toBe(true);
  expect((daemon as any).sessions.has("new")).toBe(true);
});

test("the cap never closes the conversation being opened, or a running turn", () => {
  // Two ways the cap could take work away from the user: closing the session it
  // was called for, or killing an agent mid-answer to make room.
  const { daemon } = daemonWithCollector();
  const busy = plantIdleSession(daemon, "busy", { lastUsedAt: 0, working: true });
  [1, 2, 3, 4].forEach((n) => plantIdleSession(daemon, `s${n}`, { lastUsedAt: n * 1000 }));

  (daemon as any).enforceSessionCap("s4");

  // The oldest session here is the working one, so an unguarded cap would have
  // taken exactly it.
  expect(busy.wasClosed()).toBe(false);
  expect((daemon as any).sessions.has("s4")).toBe(true);
});
