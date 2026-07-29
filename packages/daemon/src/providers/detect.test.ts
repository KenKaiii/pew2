/**
 * Detection tests.
 *
 * Everything runs against a temporary PATH and a temporary providers directory,
 * so the result never depends on what the machine running the suite happens to
 * have installed — which is exactly the property that makes detection worth
 * trusting in the first place.
 */
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG, detectProviders } from "./detect.js";
import { loadProviders } from "./registry.js";
import { ProviderManifest } from "@pew2/protocol";

/** An isolated machine: an empty PATH, and nowhere any manifest already lives. */
async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "pew2-detect-"));
  const bin = join(root, "bin");
  const providers = join(root, "providers");
  await mkdir(bin, { recursive: true });
  return {
    root,
    bin,
    providers,
    env: { PATH: bin } as NodeJS.ProcessEnv,
  };
}

/** Put an executable on the sandbox PATH. */
async function install(bin: string, command: string) {
  const path = join(bin, command);
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return path;
}

test("detects nothing on a machine with no agents installed", async () => {
  const { bin, providers, env } = await sandbox();

  const result = await detectProviders({
    env,
    targetDir: providers,
    searchDirs: [providers],
  });

  expect(result.detected).toEqual([]);
  // Every known adapter is reported as missing, with a way to get it — this is
  // what a coding agent reads to decide what to install next.
  expect(result.missing.map((m) => m.id).sort()).toEqual(CATALOG.map((c) => c.id).sort());
  for (const entry of result.missing) expect(entry.install.length).toBeGreaterThan(0);

  // Nothing was written: detection on a bare machine must not leave state behind.
  expect(await readdir(providers).catch(() => [])).toEqual([]);
  expect(bin).toBeTruthy();
});

test("writes a manifest that the registry can load and run", async () => {
  const { bin, providers, env } = await sandbox();
  const claude = await install(bin, "claude");

  const result = await detectProviders({
    env,
    targetDir: providers,
    searchDirs: [providers],
  });

  expect(result.detected).toHaveLength(1);
  const detected = result.detected[0]!;
  expect(detected).toMatchObject({
    id: "claude-code",
    action: "written",
    foundAt: claude,
  });
  expect(result.missing.some((m) => m.id === "claude-code")).toBe(false);

  // The point of the exercise: what detection wrote is a provider the daemon
  // can actually load, not merely a file on disk.
  const { providers: loaded, errors } = await loadProviders([providers], env);
  expect(errors).toEqual([]);
  expect(loaded.map((p) => p.manifest.id)).toEqual(["claude-code"]);
  expect(loaded[0]!.command).toBe("npx");
  expect(loaded[0]!.args).toContain("@agentclientprotocol/claude-agent-acp@latest");

  // Running again must be a no-op rather than a second manifest or an
  // overwrite, because an agent will loop on detect until it is satisfied.
  const again = await detectProviders({ env, targetDir: providers, searchDirs: [providers] });
  expect(again.detected).toEqual([
    { ...detected, action: "already-configured", manifestPath: join(providers, "claude-code.json") },
  ]);
  expect(await readdir(providers)).toEqual(["claude-code.json"]);
});

test("every catalog manifest is valid", () => {
  // A malformed catalog entry would only surface on the one machine that had
  // that agent installed, so it is checked here for all of them at once.
  for (const entry of CATALOG) {
    const parsed = ProviderManifest.safeParse(entry.manifest);
    expect(parsed.success ? entry.id : parsed.error.issues).toBe(entry.id);
    expect(parsed.success && parsed.data.id).toBe(entry.id);
  }
});

test("a user manifest shadows a bundled one instead of colliding", async () => {
  const { providers, env } = await sandbox();
  const bundled = join(providers, "bundled");
  const user = join(providers, "user");
  await mkdir(bundled, { recursive: true });
  await mkdir(user, { recursive: true });

  const manifest = (description: string) => ({
    id: "echo",
    name: "Echo",
    version: "0.1.0",
    description,
    distribution: { type: "command", command: "echo", args: [] },
  });
  await writeFile(join(bundled, "echo.json"), JSON.stringify(manifest("bundled")));
  await writeFile(join(user, "echo.json"), JSON.stringify(manifest("user")));

  const { providers: loaded, errors } = await loadProviders([user, bundled], env);
  expect(errors).toEqual([]);
  expect(loaded).toHaveLength(1);
  expect(loaded[0]!.manifest.description).toBe("user");
});
