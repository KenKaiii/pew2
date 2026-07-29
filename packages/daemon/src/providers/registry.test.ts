/**
 * Regression tests for provider directory resolution.
 *
 * `pew2` is linked onto PATH, so it runs from wherever the user happens to be.
 * These directories were once resolved against `process.cwd()`, which meant the
 * bundled manifests were found only when the CLI was invoked from inside the
 * checkout: `pew2 doctor` from anywhere else reported "No agents configured" on
 * a machine with four working agents.
 */
import { test, expect, afterEach } from "bun:test";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { existsSync } from "node:fs";
import {
  defaultProvidersDir,
  providerDirs,
  userProvidersDir,
  loadProviders,
} from "./registry.js";

const original = process.cwd();
afterEach(() => process.chdir(original));

/**
 * Somewhere that is definitely not the repo, and has no `providers/`.
 *
 * Returns `process.cwd()` rather than the path handed to `chdir`: on macOS
 * `/var` is a symlink to `/private/var`, so the two differ and comparing
 * against the wrong one makes an assertion pass for the wrong reason.
 */
async function elsewhere(): Promise<string> {
  process.chdir(await mkdtemp(join(tmpdir(), "pew2-cwd-")));
  return process.cwd();
}

test("defaultProvidersDir is the same absolute path from any directory", async () => {
  const fromRepo = defaultProvidersDir();

  await elsewhere();

  expect(defaultProvidersDir()).toBe(fromRepo);
  expect(isAbsolute(fromRepo)).toBe(true);
  // Pointing at the real bundled directory, not a plausible-looking path that
  // happens to be stable.
  expect(existsSync(fromRepo)).toBe(true);
  expect((await readdir(fromRepo)).some((f) => f.endsWith(".json"))).toBe(true);
});

test("defaultProvidersDir does not resolve inside the working directory", async () => {
  const cwd = await elsewhere();

  // The exact shape of the old bug: `resolve(process.cwd(), "providers")`.
  expect(defaultProvidersDir()).not.toBe(join(cwd, "providers"));
  expect(defaultProvidersDir().startsWith(cwd)).toBe(false);
});

test("providerDirs keeps user manifests ahead of bundled ones, from anywhere", async () => {
  const env = { PEW2_HOME: "/tmp/pew2-test-home" } as NodeJS.ProcessEnv;
  const fromRepo = providerDirs(env);

  await elsewhere();

  expect(providerDirs(env)).toEqual(fromRepo);
  // Order is what makes shadowing work: a user manifest must win over a bundled
  // one with the same id.
  expect(providerDirs(env)[0]).toBe(userProvidersDir(env));
  expect(providerDirs(env)[1]).toBe(defaultProvidersDir());
});

test("userProvidersDir ignores the working directory too", async () => {
  const env = { PEW2_HOME: "/tmp/pew2-test-home" } as NodeJS.ProcessEnv;
  const before = userProvidersDir(env);

  const cwd = await elsewhere();

  expect(userProvidersDir(env)).toBe(before);
  expect(userProvidersDir(env).startsWith(cwd)).toBe(false);
});

test("a relative script path resolves against the manifest, not the cwd", async () => {
  // launchd starts the daemon with no meaningful working directory, and each
  // session sets its own cwd to the user's workspace. A `./`-relative command
  // argument would otherwise point somewhere unrelated and fail at spawn.
  const before = await loadProviders();
  const echo = before.providers.find((p) => p.manifest.id === "echo");
  expect(echo).toBeDefined();
  expect(isAbsolute(echo!.args.at(-1)!)).toBe(true);
  expect(existsSync(echo!.args.at(-1)!)).toBe(true);

  await elsewhere();

  const after = await loadProviders();
  expect(after.providers.find((p) => p.manifest.id === "echo")!.args).toEqual(echo!.args);
});

test("npx package names are left alone despite containing a slash", async () => {
  const { providers } = await loadProviders();
  const claude = providers.find((p) => p.manifest.id === "claude-code");

  // A scoped package looks path-like. Rewriting it into a filesystem path
  // breaks the provider outright.
  expect(claude!.args).toContain("@agentclientprotocol/claude-agent-acp@latest");
  expect(claude!.args.every((a) => !a.startsWith("/"))).toBe(true);
});

test("the bundled providers still load when cwd is elsewhere", async () => {
  // The behaviour the user actually hit. Loading from the default dirs must
  // return the real agents no matter where the command was run.
  const fromRepo = await loadProviders();
  expect(fromRepo.providers.length).toBeGreaterThan(0);

  await elsewhere();

  const fromElsewhere = await loadProviders();
  expect(fromElsewhere.providers.map((p) => p.manifest.id)).toEqual(
    fromRepo.providers.map((p) => p.manifest.id),
  );
  expect(fromElsewhere.errors).toEqual(fromRepo.errors);
  // Named explicitly: a passing test that silently loaded zero providers would
  // be exactly as broken as the bug.
  expect(fromElsewhere.providers.map((p) => p.manifest.id)).toContain("claude-code");
});
