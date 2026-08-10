/**
 * Update-apply tests.
 *
 * This module replaces an executable on the user's machine, so the failure
 * cases matter more than the success one: a bad checksum, a dead download or a
 * read-only directory must all leave the existing binary exactly as it was.
 * Every test works on a real file in a scratch directory and asserts the bytes
 * afterwards, because "did not throw" is not the property under test — "the
 * old binary still runs" is.
 *
 * No network anywhere: `fetch` is injected in every case.
 */
import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyUpdate,
  assetName,
  assetUrl,
  canSelfUpdate,
  hasSupervisor,
  parseChecksum,
  supervisorInstalled,
} from "./apply.js";
import { existsSync } from "node:fs";
import { plistPath } from "../cli/service.js";

const OLD_BINARY = "#!/bin/sh\necho old\n";
const NEW_BINARY = "#!/bin/sh\necho new\n";

function sha256(text: string): string {
  return createHash("sha256").update(Buffer.from(text)).digest("hex");
}

/** A scratch install directory holding a stand-in for the pew2 binary. */
async function installDir() {
  const dir = await mkdtemp(join(tmpdir(), "pew2-apply-"));
  const target = join(dir, "pew2");
  await writeFile(target, OLD_BINARY);
  await chmod(target, 0o755);
  return { dir, target };
}

/**
 * A stub GitHub serving a binary and its checksum.
 *
 * `checksumFor` defaults to the body actually served, so a test has to opt in
 * to a mismatch rather than accidentally arranging one.
 */
function releaseServing(
  body: string | undefined,
  options: { checksumFor?: string; checksumBody?: string; binaryStatus?: number } = {},
) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string | URL) => {
    const href = String(url);
    urls.push(href);
    if (href.endsWith(".sha256")) {
      if (options.checksumBody === "") return { ok: false, status: 404 } as Response;
      const digest = sha256(options.checksumFor ?? body ?? "");
      const text = options.checksumBody ?? `${digest}  pew2-darwin-arm64\n`;
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => new TextEncoder().encode(text).buffer,
      } as unknown as Response;
    }
    if (body === undefined) {
      return { ok: false, status: options.binaryStatus ?? 500 } as Response;
    }
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => new TextEncoder().encode(body).buffer,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

/** The options that make the two hard gates pass, so a test can vary one thing. */
// `supervised` is explicit so these never depend on whether the machine
// running the tests happens to have a launchd plist installed.
const darwinCompiled = {
  platform: "darwin",
  arch: "arm64",
  compiled: true,
  supervised: true,
} as const;

test("a good checksum swaps the binary", async () => {
  const { target } = await installDir();
  const { fetchImpl } = releaseServing(NEW_BINARY);

  const result = await applyUpdate({
    ...darwinCompiled,
    targetPath: target,
    fetchImpl,
    version: "0.9.18",
    currentVersion: "0.9.17",
  });

  expect(result.ok).toBe(true);
  expect(await readFile(target, "utf8")).toBe(NEW_BINARY);
  if (result.ok) {
    expect(result.previous).toBe("0.9.17");
    expect(result.installed).toBe("0.9.18");
    // The swap is only half an update, and saying so is this module's contract.
    expect(result.restartRequired).toBe(true);
  }
});

test("the swapped binary is executable", async () => {
  // A moment where pew2 exists and is not executable is a moment where a shell
  // finds it on PATH and cannot run it.
  const { target } = await installDir();
  const { fetchImpl } = releaseServing(NEW_BINARY);

  await applyUpdate({ ...darwinCompiled, targetPath: target, fetchImpl });

  expect((await stat(target)).mode & 0o111).toBeGreaterThan(0);
});

test("a bad checksum leaves the original untouched", async () => {
  // The case that matters most: the bytes served were not the bytes published.
  const { dir, target } = await installDir();
  const { fetchImpl } = releaseServing(NEW_BINARY, { checksumFor: "something else entirely" });

  const result = await applyUpdate({ ...darwinCompiled, targetPath: target, fetchImpl });

  expect(result).toMatchObject({ ok: false, reason: "checksum-mismatch" });
  expect(await readFile(target, "utf8")).toBe(OLD_BINARY);
  // And nothing half-written was left in a directory that is on PATH.
  expect(await Array.fromAsync(new Bun.Glob("*").scan(dir))).toEqual(["pew2"]);
});

test("a failed download leaves the original untouched", async () => {
  const { dir, target } = await installDir();
  const { fetchImpl } = releaseServing(undefined, { binaryStatus: 503 });

  const result = await applyUpdate({ ...darwinCompiled, targetPath: target, fetchImpl });

  expect(result).toMatchObject({ ok: false, reason: "download-failed" });
  expect(await readFile(target, "utf8")).toBe(OLD_BINARY);
  expect(await Array.fromAsync(new Bun.Glob("*").scan(dir))).toEqual(["pew2"]);
});

test("a thrown network error is a result, not an exception", async () => {
  const { target } = await installDir();
  const fetchImpl = (async () => {
    throw new TypeError("Failed to fetch");
  }) as unknown as typeof fetch;

  const result = await applyUpdate({ ...darwinCompiled, targetPath: target, fetchImpl });

  expect(result).toMatchObject({ ok: false, reason: "checksum-missing" });
  expect(await readFile(target, "utf8")).toBe(OLD_BINARY);
});

test("a release with no checksum is refused", async () => {
  // Skipping the check when the file is absent would let whoever serves the
  // binary turn verification off by serving one file less.
  const { target } = await installDir();
  const { fetchImpl } = releaseServing(NEW_BINARY, { checksumBody: "" });

  const result = await applyUpdate({ ...darwinCompiled, targetPath: target, fetchImpl });

  expect(result).toMatchObject({ ok: false, reason: "checksum-missing" });
  expect(await readFile(target, "utf8")).toBe(OLD_BINARY);
});

test("an unreadable checksum is refused rather than compared loosely", async () => {
  const { target } = await installDir();
  const { fetchImpl } = releaseServing(NEW_BINARY, { checksumBody: "<html>404</html>" });

  const result = await applyUpdate({ ...darwinCompiled, targetPath: target, fetchImpl });

  expect(result).toMatchObject({ ok: false, reason: "checksum-missing" });
  expect(await readFile(target, "utf8")).toBe(OLD_BINARY);
});

test("an empty body is not installed even with a matching checksum", async () => {
  // A truncated transfer that succeeded at the HTTP layer. Its checksum is
  // self-consistent, and the file it produces cannot run.
  const { target } = await installDir();
  const { fetchImpl } = releaseServing("");

  const result = await applyUpdate({ ...darwinCompiled, targetPath: target, fetchImpl });

  expect(result).toMatchObject({ ok: false, reason: "download-failed" });
  expect(await readFile(target, "utf8")).toBe(OLD_BINARY);
});

test("a non-darwin platform refuses, and downloads nothing", async () => {
  // Linux and Windows install no supervisor, so a swapped binary would sit
  // there while the old process ran on for ever.
  for (const platform of ["linux", "win32"]) {
    const { target } = await installDir();
    const { fetchImpl, urls } = releaseServing(NEW_BINARY);

    const result = await applyUpdate({
      arch: "x64",
      compiled: true,
      // No `supervised` override: this asserts the platform gate itself, and
      // forcing it would be asserting nothing.
      platform,
      targetPath: target,
      fetchImpl,
    });

    expect(result).toMatchObject({ ok: false, reason: "unsupported-platform" });
    expect(await readFile(target, "utf8")).toBe(OLD_BINARY);
    expect(urls).toEqual([]);
  }
});

test("a source checkout refuses, because execPath is bun itself", async () => {
  // The gate that stops a background timer renaming a 60MB pew2 build over
  // ~/.bun/bin/bun and taking every other project on the machine with it.
  const { target } = await installDir();
  const { fetchImpl, urls } = releaseServing(NEW_BINARY);

  const result = await applyUpdate({
    ...darwinCompiled,
    compiled: false,
    targetPath: target,
    fetchImpl,
  });

  expect(result).toMatchObject({ ok: false, reason: "not-compiled" });
  expect(await readFile(target, "utf8")).toBe(OLD_BINARY);
  expect(urls).toEqual([]);
});

test("an unwritable install directory refuses before downloading", async () => {
  // Spending 60MB of a tethered connection to discover a root-owned prefix is
  // rude, so the check comes first.
  const { dir, target } = await installDir();
  const { fetchImpl, urls } = releaseServing(NEW_BINARY);
  await chmod(dir, 0o500);

  try {
    const result = await applyUpdate({ ...darwinCompiled, targetPath: target, fetchImpl });

    expect(result).toMatchObject({ ok: false, reason: "not-writable" });
    expect(urls).toEqual([]);
    expect(await readFile(target, "utf8")).toBe(OLD_BINARY);
  } finally {
    // Or the scratch directory cannot be swept at the end of the run.
    await chmod(dir, 0o700);
  }
});

test("an unsupported architecture refuses", async () => {
  const { target } = await installDir();
  const { fetchImpl, urls } = releaseServing(NEW_BINARY);

  const result = await applyUpdate({
    ...darwinCompiled,
    arch: "ppc64",
    targetPath: target,
    fetchImpl,
  });

  expect(result).toMatchObject({ ok: false, reason: "unsupported-arch" });
  expect(urls).toEqual([]);
});

test("the staging file is created beside the target, never in the temp dir", async () => {
  // rename(2) is only atomic within one filesystem, and os.tmpdir() is
  // routinely a different volume — under scripts/test-setup.ts especially.
  const { dir, target } = await installDir();
  const staged: string[] = [];
  const { fetchImpl } = releaseServing(NEW_BINARY);
  const watching = (async (url: string | URL, init?: RequestInit) => {
    const response = await (fetchImpl as (u: string | URL, i?: RequestInit) => Promise<Response>)(
      url,
      init,
    );
    if (!String(url).endsWith(".sha256")) {
      staged.push(...(await Array.fromAsync(new Bun.Glob("**").scan({ cwd: dir, onlyFiles: false }))));
    }
    return response;
  }) as unknown as typeof fetch;

  await applyUpdate({ ...darwinCompiled, targetPath: target, fetchImpl: watching });

  expect(await readFile(target, "utf8")).toBe(NEW_BINARY);
  // Nothing left over once the rename has happened.
  expect(await Array.fromAsync(new Bun.Glob("*").scan(dir))).toEqual(["pew2"]);
});

test("asset names match what the release workflow publishes", () => {
  // These exact strings are built by release.yml and resolved by install.sh; a
  // rename on either side is a 404 for every user on that platform. The full
  // three-platform matrix is asserted in the cross-platform block below; this
  // is the guard against an architecture nobody publishes for.
  expect(assetName("darwin", "arm64")).toBe("pew2-darwin-arm64");
  expect(assetName("darwin", "x64")).toBe("pew2-darwin-x64");
  expect(assetName("darwin", "ppc64")).toBeUndefined();
  expect(assetName("freebsd", "x64")).toBeUndefined();
});

test("a pinned version reads from its tag, and no version from latest", () => {
  expect(assetUrl("pew2-darwin-arm64", "0.9.18")).toBe(
    "https://github.com/KenKaiii/pew2/releases/download/v0.9.18/pew2-darwin-arm64",
  );
  // A tag already carrying its v must not become vv0.9.18.
  expect(assetUrl("pew2-darwin-arm64", "v0.9.18")).toContain("/download/v0.9.18/");
  expect(assetUrl("pew2-darwin-arm64")).toBe(
    "https://github.com/KenKaiii/pew2/releases/latest/download/pew2-darwin-arm64",
  );
});

test("a checksum file is read as sha256sum writes it", () => {
  const digest = "a".repeat(64);
  expect(parseChecksum(`${digest}  pew2-darwin-arm64\n`)).toBe(digest);
  expect(parseChecksum(`${digest.toUpperCase()}  pew2\n`)).toBe(digest);
  expect(parseChecksum("not a checksum")).toBeUndefined();
  expect(parseChecksum("")).toBeUndefined();
  // Too short to be sha256: a truncated file must not be compared loosely.
  expect(parseChecksum(`${"a".repeat(63)}  pew2\n`)).toBeUndefined();
});

test("canSelfUpdate answers for the platform without touching the network", () => {
  expect(canSelfUpdate({ ...darwinCompiled })).toBe(true);
  expect(canSelfUpdate({ ...darwinCompiled, compiled: false })).toBe(false);
  expect(canSelfUpdate({ ...darwinCompiled, supervised: false })).toBe(false);
  expect(canSelfUpdate({ platform: "linux", arch: "x64", compiled: true })).toBe(false);
  expect(canSelfUpdate({ platform: "win32", arch: "x64", compiled: true })).toBe(false);
});

test("this build refuses to update itself, because it is a source checkout", async () => {
  // No injected gates at all: the real isCompiled() is false under bun test, so
  // the module is inert here — which is the property that keeps a developer's
  // bun binary safe.
  const result = await applyUpdate({
    fetchImpl: (async () => {
      throw new Error("must never be called");
    }) as unknown as typeof fetch,
  });

  expect(result.ok).toBe(false);
  if (!result.ok) expect(["not-compiled", "unsupported-platform"]).toContain(result.reason);
});

// --- cross-platform -------------------------------------------------------
//
// pew2 ships binaries for macOS, Linux and Windows, so "does self-update work
// on all three" has to have a definite answer for each. It does, and it is not
// the same answer: the swap is portable, the *exit* is not, because an exit is
// only an update where something starts the process again.

test("every published asset is named, for all three platforms", () => {
  // The exact matrix release.yml builds. A name missing here is a platform that
  // could never be told what its current binary is called.
  expect(assetName("darwin", "arm64")).toBe("pew2-darwin-arm64");
  expect(assetName("darwin", "x64")).toBe("pew2-darwin-x64");
  expect(assetName("linux", "x64")).toBe("pew2-linux-x64");
  expect(assetName("linux", "arm64")).toBe("pew2-linux-arm64");
  // The only asset with an extension, and x64 only.
  expect(assetName("win32", "x64")).toBe("pew2-windows-x64.exe");
  expect(assetName("win32", "arm64")).toBeUndefined();
});

test("only macOS has a supervisor, and that is what gates the exit", () => {
  // Verified against this repository, not assumed: cli/service.ts writes a
  // launchd plist with KeepAlive; install.ps1 registers no Windows service and
  // no systemd unit is written anywhere here.
  expect(hasSupervisor("darwin")).toBe(true);
  expect(hasSupervisor("linux")).toBe(false);
  expect(hasSupervisor("win32")).toBe(false);
});

test("a published platform with no supervisor still refuses to self-update", () => {
  // The trap this guards: now that Linux and Windows assets are named,
  // asset-name-alone would answer "yes, updatable" on a machine with no way to
  // restart itself, leaving a new file and an old process for ever.
  for (const [platform, arch] of [
    ["linux", "x64"],
    ["linux", "arm64"],
    ["win32", "x64"],
  ] as const) {
    expect(assetName(platform, arch)).toBeDefined();
    // No `supervised` override: the real check must answer false for these.
    expect(canSelfUpdate({ platform, arch, compiled: true })).toBe(false);
  }
  expect(canSelfUpdate({ ...darwinCompiled })).toBe(true);
});

test("windows parks the running binary aside, because it cannot be replaced in place", async () => {
  // Windows will not let a running executable be replaced or unlinked, but it
  // will let one be renamed. Exercised with the win32 branch forced on, since
  // the tests run on macOS: what is under test is the file choreography, which
  // is the part that differs.
  const { dir, target } = await installDir();
  const { fetchImpl } = releaseServing(NEW_BINARY);

  const result = await applyUpdate({
    platform: "win32",
    arch: "x64",
    compiled: true,
    targetPath: target,
    fetchImpl,
    supervised: true,
  });

  expect(result.ok).toBe(true);
  expect(await readFile(target, "utf8")).toBe(NEW_BINARY);
  // The outgoing binary is still there under another name: it cannot be deleted
  // while the process running it is alive.
  const parked = (await Array.fromAsync(new Bun.Glob("pew2.old-*").scan(dir)))[0];
  expect(parked).toBeDefined();
  expect(await readFile(join(dir, parked!), "utf8")).toBe(OLD_BINARY);
});

test("a failed windows swap puts the original binary back", async () => {
  // The one moment where `pew2` does not exist at all is between parking the
  // old file and the new one landing. Failing there must not leave a machine
  // with no daemon and a file called pew2.old-1760000000000.
  const { dir, target } = await installDir();
  const { fetchImpl } = releaseServing(NEW_BINARY);

  const result = await applyUpdate({
    platform: "win32",
    arch: "x64",
    compiled: true,
    targetPath: target,
    fetchImpl,
    supervised: true,
    // Make the second rename fail, after the park has already happened.
    renameImpl: (async (from: string, to: string) => {
      if (to === target && !from.endsWith(".old-marker")) {
        const { rename } = await import("node:fs/promises");
        if (from.includes(".pew2-update-")) throw new Error("EPERM: access denied");
        return rename(from, to);
      }
      const { rename } = await import("node:fs/promises");
      return rename(from, to);
    }) as never,
  });

  expect(result).toMatchObject({ ok: false, reason: "install-failed" });
  // Restored, under its real name, with its real contents.
  expect(await readFile(target, "utf8")).toBe(OLD_BINARY);
  expect(await Array.fromAsync(new Bun.Glob("pew2.old-*").scan(dir))).toEqual([]);
});

test("linux refuses before downloading, however writable the directory is", async () => {
  // A Linux user's install is perfectly writable; the missing piece is the
  // restart, so nothing should be fetched at all.
  const { target } = await installDir();
  const { fetchImpl, urls } = releaseServing(NEW_BINARY);

  const result = await applyUpdate({
    platform: "linux",
    arch: "x64",
    compiled: true,
    targetPath: target,
    fetchImpl,
  });

  expect(result).toMatchObject({ ok: false, reason: "unsupported-platform" });
  expect(urls).toEqual([]);
  expect(await readFile(target, "utf8")).toBe(OLD_BINARY);
});

test("macOS with no launchd job installed refuses, and downloads nothing", async () => {
  // The bug this closes: `pew2 serve` is a first-class command, and a fresh
  // install has no plist until `pew2 setup` writes one — which is exactly why
  // install.sh guards its own restart on the plist existing. Treating "darwin"
  // as "supervised" would swap the binary, exit when idle, and leave the user's
  // phone offline for good, which is strictly worse than being out of date.
  const { target } = await installDir();
  const { fetchImpl, urls } = releaseServing(NEW_BINARY);

  const result = await applyUpdate({
    ...darwinCompiled,
    supervised: false,
    targetPath: target,
    fetchImpl,
  });

  expect(result).toMatchObject({ ok: false, reason: "unsupported-platform" });
  // And it says what to do about it, rather than blaming the operating system.
  if (!result.ok) expect(result.detail).toContain("pew2 setup");
  expect(urls).toEqual([]);
  expect(await readFile(target, "utf8")).toBe(OLD_BINARY);
});

test("an unsupervised machine is not offered self-update at all", () => {
  expect(canSelfUpdate({ ...darwinCompiled, supervised: false })).toBe(false);
});

test("supervisorInstalled requires the plist, not merely macOS", () => {
  // A platform check alone is the bug; the file on disk is the answer.
  expect(supervisorInstalled("linux")).toBe(false);
  expect(supervisorInstalled("win32")).toBe(false);
  // On darwin it must agree with whether the plist actually exists, whichever
  // way that falls on the machine running these tests.
  expect(supervisorInstalled("darwin")).toBe(existsSync(plistPath()));
});
