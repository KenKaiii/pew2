/**
 * Tests for the agent-facing setup loop.
 *
 * The property under test is not "setup prints nicely" — it is that `ok` and
 * `problems[].fix` form a loop a coding agent can actually run to completion:
 * every blocking problem names a fix, applying the fix clears the problem, and
 * `ok` only flips to true when nothing blocking is left.
 */
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { doctor } from "./doctor.js";
import { setup } from "./setup.js";

/** An isolated machine: empty PATH, empty home, no daemon. */
async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "pew2-setup-"));
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await mkdir(join(root, "home", "providers"), { recursive: true });
  return {
    root,
    bin,
    providersDir: join(root, "home", "providers"),
    env: { PATH: bin, PEW2_HOME: join(root, "home") } as NodeJS.ProcessEnv,
  };
}

async function install(bin: string, command: string) {
  await writeFile(join(bin, command), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
}

const noDaemon = async () => false;
const daemonUp = async () => true;

test("a bare machine reports blocking problems, each with a fix", async () => {
  const { providersDir, env } = await sandbox();

  const report = await doctor({ env, searchDirs: [providersDir], probeDaemon: noDaemon });

  expect(report.ok).toBe(false);
  const ids = report.problems.map((p) => p.id).sort();
  expect(ids).toEqual(["daemon-unreachable", "local-only", "no-providers"]);
  // The whole contract: an agent can act on every problem without parsing prose.
  for (const problem of report.problems) expect(problem.fix.length).toBeGreaterThan(0);
  expect(report.problems.find((p) => p.id === "no-providers")!.fix).toBe("pew2 detect");
});

test("setup configures what is installed and stops blocking once it can run", async () => {
  const { bin, providersDir, env } = await sandbox();
  await install(bin, "claude");
  // The Claude adapter is distributed via npx, so npx is what actually gets
  // spawned and what must be present for the provider to count as usable.
  await install(bin, "npx");

  // Verification is skipped: spawning a real agent needs the network, and what
  // is under test here is the decision loop, not the ACP handshake.
  const first = await setup({ env, searchDirs: [providersDir], verify: false, probeDaemon: noDaemon });

  expect(first.detect.detected.map((d) => d.id)).toEqual(["claude-code"]);
  expect(first.ok).toBe(false);
  // Only the daemon is still blocking; the provider problem resolved itself.
  expect(first.doctor.problems.map((p) => p.id)).toEqual(["daemon-unreachable", "local-only"]);
  expect(first.nextSteps).toHaveLength(1);

  // Start the daemon — the one remaining fix — and the loop terminates.
  const second = await setup({ env, searchDirs: [providersDir], verify: false, probeDaemon: daemonUp, pairing: async () => ({ token: "t".repeat(48), relay: "wss://relay.test" }), service: async () => ({ state: "running" }) });
  expect(second.ok).toBe(true);
  expect(second.nextSteps).toEqual([]);
  // Re-running never re-configures what is already there.
  expect(second.detect.detected[0]!.action).toBe("already-configured");
});

test("a missing optional API key warns without blocking", async () => {
  const { bin, providersDir, env } = await sandbox();
  await install(bin, "my-agent");
  await writeFile(
    join(providersDir, "my-agent.json"),
    JSON.stringify({
      id: "my-agent",
      name: "My Agent",
      version: "1.0.0",
      description: "Test agent.",
      distribution: { type: "command", command: "my-agent", args: [] },
      pew: { env: [{ name: "OPTIONAL_KEY", required: false }] },
    }),
  );

  const report = await doctor({ env, searchDirs: [providersDir], probeDaemon: daemonUp, pairing: async () => ({ token: "t".repeat(48), relay: "wss://relay.test" }), service: async () => ({ state: "running" }) });

  // An agent with its own login flow must not trap the setup loop.
  expect(report.ok).toBe(true);
  expect(report.problems).toEqual([]);
});

test("a required API key is reported but never blocks the loop", async () => {
  const { bin, providersDir, env } = await sandbox();
  await install(bin, "my-agent");
  await writeFile(
    join(providersDir, "my-agent.json"),
    JSON.stringify({
      id: "my-agent",
      name: "My Agent",
      version: "1.0.0",
      description: "Test agent.",
      distribution: { type: "command", command: "my-agent", args: [] },
      pew: { env: [{ name: "NEEDED_KEY", required: true }] },
    }),
  );

  const report = await doctor({ env, searchDirs: [providersDir], probeDaemon: daemonUp, pairing: async () => ({ token: "t".repeat(48), relay: "wss://relay.test" }), service: async () => ({ state: "running" }) });

  const problem = report.problems.find((p) => p.id === "provider-missing-env");
  expect(problem).toBeDefined();
  expect(problem!.provider).toBe("my-agent");
  expect(problem!.fix).toContain("NEEDED_KEY");
  // A secret is a human decision, so it is a warning: an agent cannot supply it
  // and must not loop forever waiting for one.
  expect(problem!.severity).toBe("warning");
  expect(report.ok).toBe(true);
});

test("a broken manifest blocks, and names the file to fix", async () => {
  const { providersDir, env } = await sandbox();
  await writeFile(join(providersDir, "broken.json"), "{ not json");

  const report = await doctor({ env, searchDirs: [providersDir], probeDaemon: daemonUp, pairing: async () => ({ token: "t".repeat(48), relay: "wss://relay.test" }), service: async () => ({ state: "running" }) });

  const problem = report.problems.find((p) => p.id === "manifest-invalid");
  expect(problem).toBeDefined();
  expect(problem!.severity).toBe("error");
  expect(problem!.fix).toContain("broken.json");
  expect(report.ok).toBe(false);
});

test("one working agent is enough, whatever the others are doing", async () => {
  // Nobody signs in to all thirteen: you use the one or two you pay for and the
  // rest sit unconfigured forever. `setup` used to treat any failed verification
  // as blocking, so a machine with Claude Code working and Cline never signed
  // into exited non-zero - telling someone who was completely set up that they
  // were not.
  const { bin, providersDir, env } = await sandbox();
  await install(bin, "claude");
  await install(bin, "npx");

  const ready = {
    env,
    searchDirs: [providersDir],
    probeDaemon: daemonUp,
    pairing: async () => ({ token: "t".repeat(48), relay: "wss://relay.test" }),
    service: async () => ({ state: "running" }),
  };

  const mixed = await setup({
    ...ready,
    verifyProviders: async (providers) =>
      providers.map((p, i) =>
        i === 0
          ? { id: p.manifest.id, status: "ok" as const, updates: 4 }
          : { id: p.manifest.id, status: "failed" as const, detail: "Authentication required" },
      ),
  });

  expect(mixed.ok).toBe(true);
  // And an unconfigured agent is never offered as a chore when something works.
  expect(mixed.nextSteps).toEqual([]);

  // With nothing working at all, it does block - and says what to look at.
  const none = await setup({
    ...ready,
    verifyProviders: async (providers) =>
      providers.map((p) => ({
        id: p.manifest.id,
        status: "failed" as const,
        detail: "Authentication required",
      })),
  });

  expect(none.ok).toBe(false);
  expect(none.nextSteps.join(" ")).toContain("pew2 providers verify");
});
