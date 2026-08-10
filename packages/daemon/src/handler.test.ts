/**
 * What a client is allowed to say about where an agent runs.
 *
 * `cwd` is not a preference. It decides where a process is spawned with the
 * user's full privileges, and it becomes the containment root every later
 * `image.fetch` for that session is checked against — so a path taken at face
 * value is both arbitrary execution and arbitrary file read, from a message
 * anyone holding the pairing token can send.
 */
import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMessage } from "./handler.js";
import { Daemon } from "./index.js";
import { readKnownProjects } from "./known-projects.js";
import { writeProbeCache } from "./probe-cache.js";

/**
 * A state directory of this test's own.
 *
 * Accepting a project writes it down (`known-projects.json`), so a daemon built
 * on the real environment would both read the developer's own projects and add
 * to them.
 */
function scratchHome(): NodeJS.ProcessEnv {
  return { ...process.env, PEW2_HOME: mkdtempSync(join(tmpdir(), "pew2-handler-")) };
}

/**
 * A daemon whose project bookkeeping is real and whose spawning is not.
 *
 * `knownProject` and `rememberOfferedWorkspaces` are the behaviour under test,
 * so they are the production ones; only the parts that would start an agent are
 * replaced.
 */
function stubbed(env: NodeJS.ProcessEnv = scratchHome()) {
  const daemon = new Daemon({ id: "test", name: "test" }, true, env);
  const started: Array<{ providerId: string; cwd: string }> = [];
  const resumed: Array<{ agentSessionId: string; cwd: string }> = [];
  const listed: string[] = [];

  Object.assign(daemon, {
    startSession: async (providerId: string, cwd: string) => {
      started.push({ providerId, cwd });
      return "session-1";
    },
    beginResumeSession: (_providerId: string, agentSessionId: string, cwd: string) => {
      resumed.push({ agentSessionId, cwd });
      return { sessionId: "session-1", ready: Promise.resolve() };
    },
    sessionsForProject: async (_providerId: string, cwd: string) => {
      listed.push(cwd);
      return [];
    },
    // `provider.sessions` asks the probe for `canResume`, which no preference
    // affects.
    probeProvider: async () => ({ canResume: true, configOptions: [], sessions: [] }),
    // `provider.capabilities` is answered through this instead: it is the probe
    // with the user's stored selectors folded over it. Stubbed at that seam
    // rather than under it, so a handler test never reads the real `~/.pew2`.
    capabilitiesFor: async () => ({ canResume: true, configOptions: [], sessions: [] }),
    lastWorkspace: async () => "/Users/someone/fallback",
    configOptions: () => [],
    agentSessionId: () => undefined,
    markLive: () => {},
    markStreaming: () => {},
    finishStreaming: () => {},
  });

  return { daemon, started, resumed, listed };
}

/**
 * Collect what one message produces, ignoring which way it went out.
 *
 * `deviceId` mirrors the transports, which set it only once a `hello` has been
 * verified — so leaving it off is how an unidentified frame is simulated.
 */
async function send(daemon: Daemon, message: unknown, deviceId?: string) {
  const out: any[] = [];
  await handleMessage(JSON.stringify(message), {
    daemon,
    deviceId,
    reply: (m) => out.push(m),
    broadcast: (m) => out.push(m),
    cwd: "/Users/someone/default",
  });
  return out;
}

test("a session cannot be started in a directory the daemon never offered", async () => {
  const { daemon, started } = stubbed();

  const out = await send(daemon, { t: "session.start", providerId: "echo", cwd: "/" });

  // Nothing spawned, and nothing said about whether `/` exists — the refusal is
  // the same sentence for any unknown path.
  expect(started).toEqual([]);
  expect(out.some((m) => m.t === "session.started")).toBe(false);
  expect(out[0]?.t).toBe("error");
  expect(out[0]?.message).toContain("unknown project");
});

test("a browsed directory can still be started in", async () => {
  const { daemon, started } = stubbed();
  // Exactly what the `workspaces` browse reply records before the phone sends
  // the path back.
  daemon.rememberOfferedWorkspaces(["/Users/someone/code/api"]);

  const out = await send(daemon, {
    t: "session.start",
    providerId: "echo",
    cwd: "/Users/someone/code/api",
  });

  expect(started).toEqual([{ providerId: "echo", cwd: "/Users/someone/code/api" }]);
  const announced = out.find((m) => m.t === "session.started");
  expect(announced).toBeDefined();
  // The resolved workspace travels with the announcement. Clients file sessions
  // by project and hide the ones they cannot place, so a session announced
  // without this is missing from the drawer under a selected project — and a
  // second device, which never saw the request, has nothing else to place it
  // by. Sending it here is also what stops a client guessing from its own
  // selection and filing another device's work in the wrong project.
  expect(announced?.cwd).toBe("/Users/someone/code/api");
});

test("a project chosen from the app outlives the daemon that offered it", async () => {
  // The bug this exists for: browsing to a project, then restarting the daemon
  // (an update, a crash, a development restart) while the app still holds that
  // project selected. The app re-sends the same path on every reconnect and
  // every new conversation, so "offered seconds ago" was never the real
  // lifetime of a pick.
  const env = scratchHome();
  const first = stubbed(env);
  first.daemon.rememberOfferedWorkspaces(["/Users/someone/code/api"]);
  await send(first.daemon, {
    t: "workspace.status",
    providerId: "echo",
    cwd: "/Users/someone/code/api",
  });
  // Written down on acceptance, not merely on offer.
  expect(await readKnownProjects(env)).toEqual(["/Users/someone/code/api"]);

  // A second process, with nothing in memory: exactly what the app reconnects
  // to after an update.
  const restarted = stubbed(env);
  const out = await send(restarted.daemon, {
    t: "session.start",
    providerId: "echo",
    cwd: "/Users/someone/code/api",
  });

  expect(restarted.started).toEqual([
    { providerId: "echo", cwd: "/Users/someone/code/api" },
  ]);
  expect(out.find((m) => m.t === "session.started")?.cwd).toBe("/Users/someone/code/api");
});

test("a restart does not silently answer with a different project", async () => {
  // The visible half of the same bug, and the reason it was so confusing: the
  // composer named the agent's *previous* project, so a new conversation looked
  // locked to the last repo no matter which one was picked.
  const env = scratchHome();
  const first = stubbed(env);
  first.daemon.rememberOfferedWorkspaces(["/Users/someone/code/api"]);
  await send(first.daemon, {
    t: "workspace.status",
    providerId: "echo",
    cwd: "/Users/someone/code/api",
  });

  const restarted = stubbed(env);
  const out = await send(restarted.daemon, {
    t: "workspace.status",
    providerId: "echo",
    cwd: "/Users/someone/code/api",
  });

  expect(out[0]?.t).toBe("workspace");
  expect(out[0]?.cwd).toBe("/Users/someone/code/api");
  expect(out[0]?.folder).toBe("api");
});

test("a directory that was never published stays unknown across a restart", async () => {
  // The containment is what survives, not the path: nothing is stored unless
  // this daemon published it and a client then chose it.
  const env = scratchHome();
  await send(stubbed(env).daemon, { t: "session.start", providerId: "echo", cwd: "/etc" });
  expect(await readKnownProjects(env)).toEqual([]);

  const out = await send(stubbed(env).daemon, {
    t: "session.start",
    providerId: "echo",
    cwd: "/etc",
  });
  expect(out[0]?.t).toBe("error");
  expect(out[0]?.message).toContain("unknown project");
});

test("a project with agent history is recognised before any probe has landed", async () => {
  // The app asks where the next prompt will land the instant it reconnects,
  // in the same breath as the probe that fills the in-memory project history.
  // Reading only that map made recognising a genuine project a race against an
  // agent spawn, and losing it looked identical to the bug above: the composer
  // named whatever the agent had open last.
  const env = scratchHome();
  await writeProbeCache(
    "echo",
    { canResume: true, configOptions: [], sessions: [] },
    env,
    [{ sessionId: "s1", cwd: "/Users/someone/code/api", updatedAt: "2026-08-10T12:00:00Z" }],
  );

  const { daemon, started } = stubbed(env);
  await send(daemon, {
    t: "session.start",
    providerId: "echo",
    cwd: "/Users/someone/code/api",
  });

  expect(started).toEqual([{ providerId: "echo", cwd: "/Users/someone/code/api" }]);
});

test("naming no project at all still falls back to the agent's last one", async () => {
  // The phone has no file picker, so most sessions arrive with no `cwd`. That
  // path never involved a client-supplied string and must keep working.
  const { daemon, started } = stubbed();

  const out = await send(daemon, { t: "session.start", providerId: "echo" });

  expect(started).toEqual([{ providerId: "echo", cwd: "/Users/someone/fallback" }]);
  // The fallback, not the empty request. A client cannot work out where a
  // session it did not ask for ended up, and this is the case where even the
  // client that *did* ask has no idea — it named no project at all.
  expect(out.find((m) => m.t === "session.started")?.cwd).toBe("/Users/someone/fallback");
});

test("listing a project's conversations refuses an unknown directory", async () => {
  // A listing is a question about the filesystem, so answering it for an
  // arbitrary path is an oracle even when nothing is spawned.
  const { daemon, listed } = stubbed();

  const sessions = await send(daemon, {
    t: "provider.sessions",
    providerId: "echo",
    cwd: "/etc",
  });
  expect(listed).toEqual([]);
  expect(sessions[0]?.t).toBe("error");

  daemon.rememberOfferedWorkspaces(["/Users/someone/code/api"]);
  await send(daemon, {
    t: "provider.sessions",
    providerId: "echo",
    cwd: "/Users/someone/code/api",
  });
  expect(listed).toEqual(["/Users/someone/code/api"]);
});

test("resuming falls back instead of refusing an unrecognised directory", async () => {
  // Resume is the reconnect path: the app sends it the moment the daemon
  // announces its providers, which is before the probe that fills the project
  // history has finished. A path the app is faithfully echoing from its own
  // cache is therefore not yet recognisable, and refusing would mean a
  // conversation that never reopens after the daemon is updated.
  //
  // The containment still holds — what gets spawned is the daemon's own
  // workspace, never the string the client sent.
  const { daemon, resumed } = stubbed();

  await send(daemon, {
    t: "session.resume",
    providerId: "echo",
    agentSessionId: "agent-1",
    cwd: "/etc",
  });
  expect(resumed).toEqual([
    { agentSessionId: "agent-1", cwd: "/Users/someone/fallback" },
  ]);

  // A directory the daemon did publish is used as given.
  daemon.rememberOfferedWorkspaces(["/Users/someone/code/api"]);
  await send(daemon, {
    t: "session.resume",
    providerId: "echo",
    agentSessionId: "agent-2",
    cwd: "/Users/someone/code/api",
  });
  expect(resumed[1]).toEqual({
    agentSessionId: "agent-2",
    cwd: "/Users/someone/code/api",
  });
});

test("reopening a conversation uses the project the agent recorded for it", async () => {
  // The fallback above may not guess a *different* project. Dropping to the
  // provider's last workspace reopens a conversation about one repo with the
  // agent rooted in another — every file tool in that turn then works on the
  // wrong project, and the `session.started` tells every client to file the
  // conversation there too.
  //
  // The agent's own history says where its session lives, so no guess is
  // needed. This is also the older app, which sends no `cwd` at all.
  const env = scratchHome();
  await writeProbeCache("echo", { canResume: true, configOptions: [], sessions: [] }, env, [
    { sessionId: "agent-1", cwd: "/Users/someone/code/api", updatedAt: "2026-08-10T12:00:00Z" },
  ]);
  const { daemon, resumed } = stubbed(env);

  const out = await send(daemon, {
    t: "session.resume",
    providerId: "echo",
    agentSessionId: "agent-1",
  });

  expect(resumed).toEqual([{ agentSessionId: "agent-1", cwd: "/Users/someone/code/api" }]);
  // And the announcement agrees, so no client files it under the fallback.
  expect(out.find((m) => m.t === "session.started")?.cwd).toBe("/Users/someone/code/api");
});

test("the agent's record beats a client naming some other project", async () => {
  // Both paths are ones this daemon published, so this is not containment — it
  // is which of two honest answers is about *this* conversation. A phone can be
  // holding a stale row, or simply the project it currently has selected.
  const env = scratchHome();
  await writeProbeCache("echo", { canResume: true, configOptions: [], sessions: [] }, env, [
    { sessionId: "agent-1", cwd: "/Users/someone/code/api", updatedAt: "2026-08-10T12:00:00Z" },
  ]);
  const { daemon, resumed } = stubbed(env);
  daemon.rememberOfferedWorkspaces(["/Users/someone/code/www"]);

  await send(daemon, {
    t: "session.resume",
    providerId: "echo",
    agentSessionId: "agent-1",
    cwd: "/Users/someone/code/www",
  });

  expect(resumed).toEqual([{ agentSessionId: "agent-1", cwd: "/Users/someone/code/api" }]);
  // The path the client sent is not even consulted, so it is not filed as a
  // project this client opened — it named where it happened to be looking, not
  // what it was reopening.
  expect(await readKnownProjects(env)).toEqual(["/Users/someone/code/api"]);
});

test("a push token is kept against the device that proved who it was", async () => {
  const { daemon } = stubbed();

  const out = await send(
    daemon,
    { t: "app.push", token: "ExponentPushToken[abc123]", platform: "ios" },
    "phone-1",
  );

  expect(out).toEqual([]);
  expect(daemon.pushTargets.list()).toEqual([
    { token: "ExponentPushToken[abc123]", platform: "ios" },
  ]);
});

test("a push token from an unidentified sender is refused", async () => {
  // Before `hello`, a frame cannot say whose phone it is. Storing it anyway
  // would let one connection redirect another device's notifications.
  const { daemon } = stubbed();

  const out = await send(daemon, {
    t: "app.push",
    token: "ExponentPushToken[abc123]",
    platform: "ios",
  });

  expect(daemon.pushTargets.size).toBe(0);
  expect(out[0]?.t).toBe("error");
  expect(out[0]?.code).toBe("push_unidentified");
});

test("a token that is not an Expo push token is refused out loud", async () => {
  // Silently dropping it looks exactly like success until someone waits for a
  // notification that never arrives.
  const { daemon } = stubbed();

  const out = await send(daemon, { t: "app.push", token: "abc123", platform: "ios" }, "phone-1");

  expect(daemon.pushTargets.size).toBe(0);
  expect(out[0]?.code).toBe("push_token_invalid");
});

test("reconnecting with a rotated token replaces the old one", async () => {
  // Otherwise every app restart costs another copy of every banner.
  const { daemon } = stubbed();

  await send(daemon, { t: "app.push", token: "ExponentPushToken[old]", platform: "ios" }, "phone-1");
  await send(daemon, { t: "app.push", token: "ExponentPushToken[new]", platform: "ios" }, "phone-1");

  expect(daemon.pushTargets.list()).toEqual([{ token: "ExponentPushToken[new]", platform: "ios" }]);
});
