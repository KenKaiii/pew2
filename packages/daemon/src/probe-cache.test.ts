import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readProbeCache, writeProbeCache } from "./probe-cache.js";

async function tempEnv() {
  const home = await mkdtemp(join(tmpdir(), "pew2-cache-"));
  return { PEW2_HOME: home } as NodeJS.ProcessEnv;
}

const capabilities = {
  configOptions: [],
  sessions: [
    { sessionId: "s1", cwd: "/tmp", title: "Cached conversation", messageCount: 3 },
  ],
  canResume: true,
};

test("cached commands survive the round trip, so the sheet works offline", async () => {
  // The app offers commands before any session exists, which means it is this
  // cache — not a live agent — answering on a cold start.
  const env = await tempEnv();
  await writeProbeCache(
    "claude-code",
    {
      ...capabilities,
      commands: [{ name: "commit", description: "Commit the work" }],
    },
    env,
  );

  expect((await readProbeCache("claude-code", env))?.commands).toEqual([
    { name: "commit", description: "Commit the work" },
  ]);
});

test("a cache written before commands existed still reads", async () => {
  // `commands` is optional precisely so an older daemon's file is not a miss:
  // dropping it would reprobe every provider on the first launch after upgrade.
  const env = await tempEnv();
  await writeProbeCache("ggcoder", capabilities, env);

  const cached = await readProbeCache("ggcoder", env);
  expect(cached?.commands).toBe(undefined);
  expect(cached?.sessions).toHaveLength(1);
});

test("a written probe reads back with its timestamp", async () => {
  const env = await tempEnv();
  await writeProbeCache("ggcoder", capabilities, env);

  const cached = await readProbeCache("ggcoder", env);
  expect(cached?.sessions[0]?.title).toBe("Cached conversation");
  expect(cached?.canResume).toBe(true);
  expect(Date.now() - (cached?.probedAt ?? 0)).toBeLessThan(5000);
});

test("cached history is capped at the 30 newest sessions", async () => {
  const env = await tempEnv();
  await writeProbeCache(
    "ggcoder",
    {
      ...capabilities,
      sessions: Array.from({ length: 36 }, (_, index) => ({
        sessionId: `s${index}`,
        cwd: "/tmp",
        title: `Session ${index}`,
        messageCount: index,
      })),
    },
    env,
  );

  const cached = await readProbeCache("ggcoder", env);

  expect(cached?.sessions).toHaveLength(30);
  expect(cached?.sessions.at(-1)?.sessionId).toBe("s29");
});

test("the project list survives the round trip, so the menu works on a cold start", async () => {
  // The phone offers projects before any agent has been spawned this boot,
  // which means it is this cache answering — same reason `commands` is here.
  const env = await tempEnv();
  await writeProbeCache(
    "claude-code",
    { ...capabilities, projects: [{ path: "/a/pew2", name: "pew2", sessions: 12 }] },
    env,
  );

  expect((await readProbeCache("claude-code", env))?.projects).toEqual([
    { path: "/a/pew2", name: "pew2", sessions: 12 },
  ]);
});

test("the uncapped history is cached alongside the capped one", async () => {
  // `sessions` is the drawer's recent-work window; choosing a project needs a
  // different slice, so the whole list is kept — past the 30-row cap.
  const env = await tempEnv();
  const all = Array.from({ length: 40 }, (_, index) => ({
    sessionId: `s${index}`,
    cwd: index % 2 === 0 ? "/a/pew2" : "/a/site",
    title: `Session ${index}`,
    messageCount: index,
  }));
  await writeProbeCache("ggcoder", capabilities, env, all);

  const cached = await readProbeCache("ggcoder", env);
  expect(cached?.sessions).toHaveLength(1);
  expect(cached?.allSessions).toHaveLength(40);
  // Counts are dropped deliberately: they are read per project, on demand, so
  // caching them would pin a number that goes stale the next time the agent is
  // used at the desk.
  expect(cached?.allSessions?.[0]?.messageCount).toBeUndefined();
  expect(cached?.allSessions?.[0]?.cwd).toBe("/a/pew2");
});

test("a pathological history is capped before it becomes a megabyte to parse", async () => {
  const env = await tempEnv();
  await writeProbeCache(
    "ggcoder",
    capabilities,
    env,
    Array.from({ length: 600 }, (_, index) => ({
      sessionId: `s${index}`,
      cwd: "/a/pew2",
      title: `Session ${index}`,
    })),
  );

  expect((await readProbeCache("ggcoder", env))?.allSessions).toHaveLength(500);
});

test("a cache written before projects existed still reads", async () => {
  // Same contract as `commands`: an older daemon's file must not be a miss, or
  // every provider reprobes on the first launch after an upgrade.
  const env = await tempEnv();
  await writeProbeCache("ggcoder", capabilities, env);

  const cached = await readProbeCache("ggcoder", env);
  expect(cached?.projects).toBeUndefined();
  expect(cached?.allSessions).toBeUndefined();
  expect(cached?.sessions).toHaveLength(1);
});

test("a missing or corrupt cache is a miss, never an error", async () => {
  const env = await tempEnv();
  expect(await readProbeCache("nobody", env)).toBeUndefined();

  await writeFile(join(env.PEW2_HOME!, "cache", "broken.json"), "{not json", {
    encoding: "utf8",
  }).catch(async () => {
    // The cache directory may not exist yet; create it and retry once.
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(env.PEW2_HOME!, "cache"), { recursive: true });
    await writeFile(join(env.PEW2_HOME!, "cache", "broken.json"), "{not json");
  });
  expect(await readProbeCache("broken", env)).toBeUndefined();
});

test("a daemon answers from disk without spawning the agent", async () => {
  const env = await tempEnv();
  // A cache entry with a marker no live probe would produce.
  await writeProbeCache("echo", capabilities, env);

  const home = process.env.PEW2_HOME;
  process.env.PEW2_HOME = env.PEW2_HOME;
  try {
    const { Daemon } = await import("./index.js");
    const daemon = new Daemon({ id: "test", name: "test" }, true);
    await daemon.refreshProviders();

    const started = Date.now();
    const caps = await daemon.probeProvider("echo");
    const elapsed = Date.now() - started;

    expect(caps.sessions[0]?.title).toBe("Cached conversation");
    // Spawning the echo agent takes hundreds of ms; disk is ~none.
    expect(elapsed).toBeLessThan(200);
    daemon.closeAll();
  } finally {
    if (home === undefined) delete process.env.PEW2_HOME;
    else process.env.PEW2_HOME = home;
  }
});

test("a warm spare is offered before the probe finishes listing history", async () => {
  // Listing sessions and counting each one's messages is seconds of disk work
  // for a real agent, and opening a *new* conversation needs none of it. The
  // spare must therefore be adoptable as soon as the process answers — when the
  // two were one promise, the first tap paid for the whole history scan.
  const env = await tempEnv();
  const home = process.env.PEW2_HOME;
  process.env.PEW2_HOME = env.PEW2_HOME;
  try {
    const { Daemon } = await import("./index.js");
    const daemon = new Daemon({ id: "test", name: "test" }, true);
    await daemon.refreshProviders();

    const probe = daemon.probeProvider("echo");
    let listed = false;
    void probe.then(() => {
      listed = true;
    });

    await (daemon as any).awaitSpare("echo");

    // Asked by directory rather than by provider id: spares are keyed by both,
    // so that a second project can stay warm too.
    expect(daemon.spareDirs("echo").length).toBeGreaterThan(0);
    expect(listed).toBe(false);

    await probe;
    daemon.closeAll();
  } finally {
    if (home === undefined) delete process.env.PEW2_HOME;
    else process.env.PEW2_HOME = home;
  }
});

test("a cache without message counts is still served from disk", async () => {
  const env = await tempEnv();
  await writeProbeCache(
    "echo",
    {
      ...capabilities,
      sessions: [{ sessionId: "old", cwd: "/tmp", title: "Missing its count" }],
    },
    env,
  );

  const home = process.env.PEW2_HOME;
  process.env.PEW2_HOME = env.PEW2_HOME;
  try {
    const { Daemon } = await import("./index.js");
    const daemon = new Daemon({ id: "test", name: "test" }, true);
    await daemon.refreshProviders();

    const caps = await daemon.probeProvider("echo");

    // Served straight off disk, counts or not. Requiring a count here would
    // have made the gate permanently false now that counts only appear when
    // the agent itself supplies one — every drawer open would pay a spawn.
    expect(caps.sessions[0]?.title).toBe("Missing its count");
    daemon.closeAll();
  } finally {
    if (home === undefined) delete process.env.PEW2_HOME;
    else process.env.PEW2_HOME = home;
  }
});
