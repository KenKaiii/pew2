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
import { handleMessage } from "./handler.js";
import { Daemon } from "./index.js";

/**
 * A daemon whose project bookkeeping is real and whose spawning is not.
 *
 * `knownProject` and `rememberOfferedWorkspaces` are the behaviour under test,
 * so they are the production ones; only the parts that would start an agent are
 * replaced.
 */
function stubbed() {
  const daemon = new Daemon({ id: "test", name: "test" }, true);
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
  expect(out.some((m) => m.t === "session.started")).toBe(true);
});

test("naming no project at all still falls back to the agent's last one", async () => {
  // The phone has no file picker, so most sessions arrive with no `cwd`. That
  // path never involved a client-supplied string and must keep working.
  const { daemon, started } = stubbed();

  await send(daemon, { t: "session.start", providerId: "echo" });

  expect(started).toEqual([{ providerId: "echo", cwd: "/Users/someone/fallback" }]);
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
