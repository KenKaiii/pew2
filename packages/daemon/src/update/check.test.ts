/**
 * Update-check tests.
 *
 * Two things decide whether this is safe to run in a background timer: it must
 * answer correctly when GitHub answers, and it must never throw when GitHub
 * does anything else. Every failure path is asserted here, because the caller
 * is a daemon holding the user's session and an unhandled rejection there costs
 * far more than a missed update.
 *
 * No network: `fetch` is injected in every case.
 */
import { test, expect } from "bun:test";
import {
  CURRENT_VERSION,
  RELEASE_API_URL,
  checkForUpdate,
  compareVersions,
} from "./check.js";

/** A stub that answers one release payload, and records how it was called. */
function githubReturning(tagName: unknown, init: { ok?: boolean; status?: number } = {}) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  // `string | URL` rather than fetch's full `string | URL | Request`: a Request
  // has no meaningful string form, and this module only ever passes a string.
  const fetchImpl = (async (url: string | URL, options?: RequestInit) => {
    calls.push({
      url: String(url),
      headers: (options?.headers ?? {}) as Record<string, string>,
    });
    return {
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => ({ tag_name: tagName }),
    } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

test("a newer release is reported as an update", async () => {
  const { fetchImpl } = githubReturning("v0.9.18");

  const result = await checkForUpdate({ currentVersion: "0.9.17", fetchImpl });

  expect(result).toEqual({ current: "0.9.17", latest: "0.9.18", newer: true });
});

test("the same release is not an update", async () => {
  const { fetchImpl } = githubReturning("v0.9.17");

  const result = await checkForUpdate({ currentVersion: "0.9.17", fetchImpl });

  expect(result).toEqual({ current: "0.9.17", latest: "0.9.17", newer: false });
});

test("an older release is not an update", async () => {
  // A local build ahead of the published one, which is every development
  // machine between cutting a fix and tagging it. Never offer a downgrade.
  const { fetchImpl } = githubReturning("v0.9.16");

  const result = await checkForUpdate({ currentVersion: "0.9.17", fetchImpl });

  expect(result).toEqual({ current: "0.9.17", latest: "0.9.16", newer: false });
});

test("a network failure answers null instead of throwing", async () => {
  // The daemon runs this on a timer while holding the user's session. A
  // rejection escaping here would be an unhandled rejection in that process.
  const fetchImpl = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;

  const result = await checkForUpdate({ currentVersion: "0.9.17", fetchImpl });

  expect(result).toBeNull();
});

test("a timeout answers null", async () => {
  const fetchImpl = (async (_url: string, options?: RequestInit) => {
    // Exactly what an aborted fetch does: reject with the signal's reason.
    throw options?.signal?.reason ?? new Error("aborted");
  }) as unknown as typeof fetch;

  const result = await checkForUpdate({ currentVersion: "0.9.17", fetchImpl, timeoutMs: 1 });

  expect(result).toBeNull();
});

test("a rate-limited or missing release answers null", async () => {
  // 403 is GitHub's unauthenticated rate limit and 404 a repository with no
  // release yet. Both are ordinary; neither means "up to date".
  for (const status of [403, 404, 500]) {
    const { fetchImpl } = githubReturning("v9.9.9", { ok: false, status });

    expect(await checkForUpdate({ currentVersion: "0.9.17", fetchImpl })).toBeNull();
  }
});

test("a malformed body answers null", async () => {
  const fetchImpl = (async () =>
    ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
    }) as unknown as Response) as unknown as typeof fetch;

  const result = await checkForUpdate({ currentVersion: "0.9.17", fetchImpl });

  expect(result).toBeNull();
});

test("a release with no usable tag answers null", async () => {
  for (const tag of [undefined, null, 42, "", "nightly", "v", "1.2.x"]) {
    const { fetchImpl } = githubReturning(tag);

    expect(await checkForUpdate({ currentVersion: "0.9.17", fetchImpl })).toBeNull();
  }
});

test("a runtime with no fetch answers null rather than throwing", async () => {
  // `null`, not `undefined`: a destructuring default only fills in `undefined`,
  // so passing that would fall through to the real `globalThis.fetch` and put a
  // live GitHub request inside the test suite. This reaches the guard instead,
  // which is what protects a runtime that has no global fetch at all.
  const result = await checkForUpdate({
    currentVersion: "0.9.17",
    fetchImpl: null as unknown as typeof fetch,
  });

  expect(result).toBeNull();
});

test("asks GitHub for this repository, identifying itself", async () => {
  const { fetchImpl, calls } = githubReturning("v1.0.0");

  await checkForUpdate({ currentVersion: "0.9.17", fetchImpl });

  expect(calls).toHaveLength(1);
  expect(calls[0]!.url).toBe(RELEASE_API_URL);
  // GitHub refuses a request without a User-Agent.
  expect(calls[0]!.headers["User-Agent"]).toContain("pew2-daemon/");
});

test("a tag with or without the v prefix reads the same", async () => {
  const prefixed = await checkForUpdate({
    currentVersion: "1.0.0",
    fetchImpl: githubReturning("v1.0.1").fetchImpl,
  });
  const bare = await checkForUpdate({
    currentVersion: "1.0.0",
    fetchImpl: githubReturning("1.0.1").fetchImpl,
  });

  expect(prefixed).toEqual({ current: "1.0.0", latest: "1.0.1", newer: true });
  expect(bare).toEqual(prefixed);
});

test("versions are ordered numerically, not as strings", () => {
  // The bug this exists to prevent: lexically "0.9.10" sorts below "0.9.9", so
  // the tenth patch of a series would read as a downgrade and never install.
  expect(compareVersions("0.9.10", "0.9.9")).toBeGreaterThan(0);
  expect(compareVersions("0.10.0", "0.9.99")).toBeGreaterThan(0);
  expect(compareVersions("1.0.0", "0.99.99")).toBeGreaterThan(0);
  expect(compareVersions("2.0.0", "10.0.0")).toBeLessThan(0);
});

test("a missing segment is zero, so 1.2 and 1.2.0 are one release", () => {
  expect(compareVersions("1.2", "1.2.0")).toBe(0);
  expect(compareVersions("1.2.0.0", "1.2")).toBe(0);
  expect(compareVersions("1.2.1", "1.2")).toBeGreaterThan(0);
});

test("a prerelease is not offered as an upgrade over its release", () => {
  // GitHub's "latest" excludes prereleases, so one only arrives here if it was
  // published as latest deliberately. Equal beats offering a downgrade to rc.
  expect(compareVersions("1.2.0-rc1", "1.2.0")).toBe(0);
  expect(compareVersions("1.2.0+build7", "1.2.0")).toBe(0);
});

test("an unreadable version is unanswerable, not merely older", () => {
  // `undefined` keeps "cannot tell" distinct from "no update", so a broken tag
  // can never be mistaken for a reason to act.
  expect(compareVersions("nightly", "1.0.0")).toBeUndefined();
  expect(compareVersions("1.0.0", "")).toBeUndefined();
  expect(compareVersions("1.0.0", "1.0.0.0.0")).toBeUndefined();
});

test("the version this build reports is a real version", () => {
  // Guards the compiled-binary import: a bundler that dropped package.json
  // would leave this undefined, and every future comparison unanswerable.
  expect(CURRENT_VERSION).toMatch(/^\d+\.\d+\.\d+/);
  expect(compareVersions(CURRENT_VERSION, CURRENT_VERSION)).toBe(0);
});

test("the real build compares cleanly against a plausible next release", async () => {
  const { fetchImpl } = githubReturning("v999.0.0");

  const result = await checkForUpdate({ fetchImpl });

  expect(result).toEqual({ current: CURRENT_VERSION, latest: "999.0.0", newer: true });
});
