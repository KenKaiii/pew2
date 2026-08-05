/**
 * End-to-end pipeline tests against the local echo agent.
 *
 * These run with no API key and no network, so they are safe to run in CI and
 * are the regression net for the provider contract itself.
 */
import { basename, join } from "node:path";
import { mkdtemp } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { test, expect } from "bun:test";
import { loadProviders } from "../providers/registry.js";
import { connectProvider } from "../acp/connect.js";
import { SessionLog } from "../session/log.js";
import { mergeAgentSessions } from "../../../app/src/agentHistory.js";
import { formatHistoryMetadata } from "../../../app/src/historyMetadata.js";

async function echoProvider() {
  const { providers } = await loadProviders();
  const provider = providers.find((p) => p.manifest.id === "echo");
  if (!provider) throw new Error("echo provider missing");
  return provider;
}

test("streams incremental updates and records them in order", async () => {
  const log = new SessionLog("test-session");
  const handle = await connectProvider({
    provider: await echoProvider(),
    cwd: process.cwd(),
    onUpdate: (payload) => log.append(payload),
    onPermissionRequest: () => {},
  });

  await handle.prompt("hello world");
  handle.close();

  expect(log.events.length).toBeGreaterThan(1);

  // Sequence numbers must be gapless and monotonic — this is what makes
  // reconnect-and-replay correct on the phone.
  const seqs = log.events.map((e) => e.seq);
  expect(seqs).toEqual(seqs.map((_, i) => i));

  const text = log.events
    .map((e) => (e as any).payload?.update?.content?.text ?? "")
    .join("");
  expect(text).toContain("hello world");
}, 60_000);

test("permission request round-trips through the client", async () => {
  const log = new SessionLog("test-permission");
  let sawRequest = false;

  const handle = await connectProvider({
    provider: await echoProvider(),
    cwd: process.cwd(),
    onUpdate: (payload) => log.append(payload),
    onPermissionRequest: ({ requestId }) => {
      sawRequest = true;
      handle.answerPermission(requestId, "allow");
    },
  });

  await handle.prompt("please ask for permission");
  handle.close();

  expect(sawRequest).toBe(true);
  const text = log.events
    .map((e) => (e as any).payload?.update?.content?.text ?? "")
    .join("");
  expect(text).toContain("You chose: allow");
}, 60_000);

test("a rejected request surfaces the agent's reason, not 'Internal error'", async () => {
  const handle = await connectProvider({
    provider: await echoProvider(),
    cwd: process.cwd(),
    onUpdate: () => {},
    onPermissionRequest: () => {},
  });

  try {
    // The SDK wraps a thrown agent error as a JSON-RPC "Internal error" and
    // hides the real sentence in `data`. Reading the top-level message instead
    // is what put a useless label — or a JSON blob — on the phone.
    const failure = await handle
      .setConfigOption("model", "not-a-real-model")
      .then(() => undefined)
      .catch((error: Error) => error.message);

    expect(failure).toBe("Invalid value 'not-a-real-model' for 'model'");
  } finally {
    handle.close();
  }
}, 60_000);

test("a session adopts the warm spare instead of spawning again", async () => {
  const { Daemon } = await import("../index.js");
  const daemon = new Daemon({ id: "test", name: "test" }, true);
  await daemon.refreshProviders();

  // The probe leaves its booted agent behind as the spare. Forced live: a
  // disk-cached probe from an earlier run would answer without spawning, and
  // there would be no spare to adopt.
  await daemon.probeProvider("echo", { refresh: true });
  const spare = (daemon as any).spares.get(`echo\u0000${process.cwd()}`)?.handle;
  expect(spare).toBeDefined();

  const sessionId = await daemon.startSession("echo", process.cwd());
  const session = (daemon as any).sessions.get(sessionId);

  // Same process, new conversation: no second spawn, no cold wait.
  expect(session.handle).toBe(spare);

  // The adopted session answers prompts on the reused connection.
  await daemon.prompt(sessionId, "warm prompt");
  await new Promise((r) => setTimeout(r, 500));
  expect(session.log.events.some((e: any) => e.payload?.kind === "user_message")).toBe(true);

  daemon.closeAll();
}, 60_000);

test("an unopened session crosses ACP, daemon state, and drawer formatting with its count", async () => {
  const { Daemon } = await import("../index.js");
  const daemon = new Daemon({ id: "test", name: "test" }, true);
  await daemon.refreshProviders();

  try {
    const capabilities = await daemon.probeProvider("echo", { refresh: true });
    const sessions = mergeAgentSessions(
      [],
      "echo",
      capabilities.sessions,
      capabilities.canResume,
      Date.now(),
    );
    const unopened = sessions.find((session) => session.agentSessionId === "echo_history_1");

    expect(unopened).toBeDefined();
    expect(unopened!.turns).toEqual([]);
    // The folder name comes from `process.cwd()` by way of the echo agent, so
    // hardcoding "pew2" made this pass only in a checkout that happened to be
    // named that — it failed in a clone, a worktree, or CI with a different
    // directory. The count is the part under test; the folder is incidental.
    expect(formatHistoryMetadata(unopened!)).toBe(`6 messages · ${basename(process.cwd())}`);
  } finally {
    daemon.closeAll();
  }
}, 60_000);

test("updates route to the session they belong to on a reused connection", async () => {
  const handle = await connectProvider({
    provider: await echoProvider(),
    cwd: process.cwd(),
    onUpdate: () => {},
    onPermissionRequest: () => {},
  });

  try {
    const firstSessionId = handle.sessionId;
    const seen: unknown[] = [];
    await handle.adopt({
      cwd: process.cwd(),
      onUpdate: (payload) => seen.push(payload),
      onPermissionRequest: () => {},
    });

    // A new session on the same process, and prompts now target it.
    expect(handle.sessionId).not.toBe(firstSessionId);
    await handle.prompt("Adoption check");
    await new Promise((r) => setTimeout(r, 500));

    // Its echo arrived through the adopted route.
    expect(seen.length).toBeGreaterThan(0);
  } finally {
    handle.close();
  }
}, 60_000);

test("no session event ever precedes session.started", async () => {
  // Through the real handler with the real echo agent. A client that saw an
  // event first would drop it as an unknown session — the empty-resume bug.
  const { Daemon } = await import("../index.js");
  const { handleMessage } = await import("../handler.js");

  const daemon = new Daemon({ id: "test", name: "test" }, true);
  await daemon.refreshProviders();

  const frames: any[] = [];
  daemon.attach((message) => frames.push(message));

  await handleMessage(
    JSON.stringify({ t: "session.start", providerId: "echo", requestId: "r1" }),
    {
      daemon,
      reply: (message) => frames.push(message),
      broadcast: (message) => frames.push(message),
    },
  );

  const started = frames.find((f) => f.t === "session.started");
  expect(started).toBeDefined();
  const events = frames.filter(
    (f) => f.t === "session.event" && f.sessionId === started.sessionId,
  );
  for (const event of events) {
    expect(frames.indexOf(event)).toBeGreaterThan(frames.indexOf(started));
  }

  daemon.closeAll();
}, 60_000);

test("replay after a cursor returns only newer events", () => {
  const log = new SessionLog("s");
  log.append({ n: 1 });
  log.append({ n: 2 });
  log.append({ n: 3 });

  expect(log.since(0).map((e) => (e.payload as any).n)).toEqual([2, 3]);
  expect(log.since(2)).toHaveLength(0);
});

test("an adopted warm process opens in the project it was asked for", async () => {
  // The bug this pins: the daemon keeps a warm agent process so a new
  // conversation opens instantly, but that process was booted by the
  // capability probe against the *probe's* workspace — the home directory,
  // under launchd. Adoption then created the session without saying where it
  // should run, so the agent inherited the spawn directory.
  //
  // The symptom was picking a project on the phone, asking the agent what
  // directory it was in, and being told the home folder. Everything looked
  // connected; the work would just have happened in the wrong place.
  const handle = await connectProvider({
    provider: await echoProvider(),
    // Stand-in for the probe's workspace: not the project, and not where the
    // next conversation should run.
    cwd: homedir(),
    onUpdate: () => {},
    onPermissionRequest: () => {},
  });

  try {
    const project = process.cwd();
    const said: string[] = [];
    await handle.adopt({
      cwd: project,
      onUpdate: (payload) => {
        const update = (payload as { update?: { content?: { text?: string } } }).update;
        const text = update?.content?.text;
        if (typeof text === "string") said.push(text);
      },
      onPermissionRequest: () => {},
    });

    await handle.prompt("pwd");
    await new Promise((r) => setTimeout(r, 500));

    expect(said).toContain(project);
    expect(said).not.toContain(homedir());
  } finally {
    handle.close();
  }
}, 60_000);

test("a warm process is not reused for a different project", async () => {
  // The second half of the same bug, and the worse half.
  //
  // Passing `cwd` on `session/new` fixes agents that honour it. Several do not:
  // they run in whatever directory their process was spawned in, so a warm
  // process booted for one project cannot be moved to another at all. Adopting
  // one anyway gave an agent that looked connected and correct while reading
  // and writing a completely different tree.
  //
  // So a spare is identified by its directory, and a session somewhere else
  // spawns cold instead. Verified through the daemon rather than the handle,
  // because the decision lives in `takeSpare`.
  const { Daemon } = await import("../index.js");
  const daemon = new Daemon({ id: "test", name: "test" }, true);
  await daemon.refreshProviders();

  try {
    await daemon.probeProvider("echo", { refresh: true });
    const warmedDirs = daemon.spareDirs("echo");
    expect(warmedDirs.length).toBe(1);
    const warmed = { cwd: warmedDirs[0]! };

    // Somewhere real, and definitely not where the spare was booted.
    const elsewhere = await mkdtemp(join(tmpdir(), "pew2-elsewhere-"));
    expect(elsewhere).not.toBe(warmed.cwd);

    await daemon.startSession("echo", elsewhere);

    // The original spare is still there, untouched: the session spawned its own
    // process rather than taking one pinned to another directory.
    expect(daemon.spareDirs("echo")).toContain(warmed.cwd);
  } finally {
    daemon.closeAll();
  }
}, 60_000);

test("a second project can be warm at the same time as the first", async () => {
  // The cost of keying spares by directory, paid back. Keyed by provider alone,
  // exactly one project could be warm and every other one paid a full cold
  // spawn — two to three seconds of empty thread after tapping a conversation.
  const { Daemon } = await import("../index.js");
  const daemon = new Daemon({ id: "test", name: "test" }, true);
  await daemon.refreshProviders();

  try {
    await daemon.probeProvider("echo", { refresh: true });
    const first = daemon.spareDirs("echo")[0]!;

    // Opening elsewhere spawns cold and leaves its own process behind.
    const elsewhere = await mkdtemp(join(tmpdir(), "pew2-second-"));
    await daemon.startSession("echo", elsewhere);
    await new Promise((r) => setTimeout(r, 800));

    const dirs = daemon.spareDirs("echo");
    expect(dirs).toContain(first);
    expect(dirs).toContain(elsewhere);

    // And the next conversation there adopts it rather than spawning again.
    const before = daemon.spareDirs("echo").length;
    await daemon.startSession("echo", elsewhere);
    expect(daemon.spareDirs("echo").length).toBeLessThan(before + 1);
  } finally {
    daemon.closeAll();
  }
}, 60_000);
