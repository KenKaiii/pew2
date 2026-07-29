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
  sessions: [{ sessionId: "s1", cwd: "/tmp", title: "Cached conversation" }],
  canResume: true,
};

test("a written probe reads back with its timestamp", async () => {
  const env = await tempEnv();
  await writeProbeCache("ggcoder", capabilities, env);

  const cached = await readProbeCache("ggcoder", env);
  expect(cached?.sessions[0]?.title).toBe("Cached conversation");
  expect(cached?.canResume).toBe(true);
  expect(Date.now() - (cached?.probedAt ?? 0)).toBeLessThan(5000);
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
