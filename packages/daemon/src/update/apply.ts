/**
 * Replace this machine's `pew2` binary with a newly published one.
 *
 * Step two of self-update: download, verify, swap. It still does not restart
 * anything — the running process keeps executing the old inode until something
 * ends it, which is deliberate and is the whole reason the swap is safe to do
 * while the daemon is serving a phone.
 *
 * ## Why a rename, and why beside the target
 *
 * `rename(2)` is atomic within a filesystem: the directory entry points at the
 * old inode or the new one, never at half a file. A reader that opened the old
 * binary keeps it — which is what lets a running daemon be replaced under
 * itself instead of crashing on a truncated executable. Writing in place would
 * do exactly that, and on macOS is refused outright for a running image.
 *
 * Atomicity stops at the filesystem boundary, so the staging file is created in
 * the *install directory*, not in `os.tmpdir()`. A temp dir is routinely a
 * different volume (and under `scripts/test-setup.ts` it is a different one
 * again), where `rename` fails with EXDEV and the fallback everyone reaches for
 * — copy then delete — is the non-atomic operation this is avoiding.
 *
 * ## Two hard gates, both about not destroying a working machine
 *
 * **darwin only.** Replacing the binary is only half an update; the process has
 * to end for it to take effect, and ending it is only survivable where a
 * supervisor brings it back. Only macOS has one: `cli/service.ts` installs a
 * launchd plist with `KeepAlive: true`. `install.ps1` registers no Windows
 * service and no scheduled task, and no systemd unit is written anywhere in
 * this repository. Swapping the binary on those platforms would leave the user
 * with a new file, an old process, and no way to close the gap except by hand.
 *
 * **Compiled builds only.** `process.execPath` is the running executable, which
 * for a released install is `pew2` — but under `bun run packages/daemon/src/
 * server.ts` it is the developer's **`bun` binary**. Renaming a 60MB pew2 build
 * over `~/.bun/bin/bun` would replace the runtime every other project on that
 * machine depends on, from a background timer, with no prompt. `isCompiled()`
 * is the same check `service.ts` uses to decide what to put in the plist, and
 * it is what keeps this module inert in development.
 *
 * Nothing here throws. Every outcome is a value, because the eventual caller is
 * a timer inside a daemon holding someone's session, and an exception there
 * costs far more than a skipped update.
 */
import { createHash } from "node:crypto";
import { access, chmod, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { platform as osPlatform } from "node:os";
import { dirname, join } from "node:path";
import { isCompiled, supervisorInstalled as serviceInstalled } from "../cli/service.js";
import { CURRENT_VERSION } from "./check.js";

/** Where releases are published. `install.sh` resolves the same repository. */
const REPO = "KenKaiii/pew2";

/**
 * How long to wait on a download before giving up.
 *
 * Far longer than the version check's ten seconds: this is a ~60MB binary, and
 * a slow connection is not a failure. Still bounded, because a stalled socket
 * must not pin the staging file open indefinitely.
 */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Why an update did not happen.
 *
 * Distinct rather than a single "failed", because the sensible response differs:
 * `unsupported-platform` is permanent and must not be retried, `download-failed`
 * is worth trying again tomorrow, and `checksum-mismatch` is the one that should
 * be surfaced loudly — it means the bytes served were not the bytes published.
 */
export type ApplyFailure =
  | "unsupported-platform"
  | "not-compiled"
  | "unsupported-arch"
  | "download-failed"
  | "checksum-missing"
  | "checksum-mismatch"
  | "not-writable"
  | "install-failed";

export type ApplyResult =
  | {
      ok: true;
      /** The version that was running before the swap. */
      previous: string;
      /** The version now on disk, waiting for a restart to take effect. */
      installed: string;
      /** The binary that was replaced. */
      path: string;
      /** Always true here, and the reason this is not the end of the story. */
      restartRequired: true;
    }
  | { ok: false; reason: ApplyFailure; detail: string };

export interface ApplyOptions {
  /** The release to install, e.g. `"0.9.18"`. Defaults to whatever is latest. */
  version?: string;
  /** Injected so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** The binary to replace. Defaults to the running executable. */
  targetPath?: string;
  /** Overridden in tests; defaults to the real platform. */
  platform?: string;
  /** Overridden in tests; defaults to the real architecture. */
  arch?: string;
  /**
   * Whether this is a compiled binary rather than a source checkout.
   *
   * Injectable only so the tests can exercise the path at all — in a source
   * checkout, which is where tests run, the real check is always false.
   */
  compiled?: boolean;
  /** The version running now, for the result and the User-Agent. */
  currentVersion?: string;
  timeoutMs?: number;
  /**
   * Override the supervisor gate.
   *
   * Only so the tests can exercise the Windows file choreography, which is real
   * code that would otherwise be unreachable from a macOS test run. Production
   * callers leave this alone and get the platform's honest answer.
   */
  supervised?: boolean;
  /** Injected so a test can fail the swap at an exact moment. */
  renameImpl?: typeof rename;
}

/**
 * The published asset name for a platform, or undefined if there isn't one.
 *
 * Exactly the matrix `release.yml` builds and the install scripts resolve by
 * name. Linux arm64 is deliberately absent from the installers but is published,
 * so it is named here too — a machine that got its binary by hand can still be
 * told what the current one is called.
 */
export function assetName(platform: string, arch: string): string | undefined {
  if (platform === "darwin") {
    if (arch === "arm64") return "pew2-darwin-arm64";
    if (arch === "x64") return "pew2-darwin-x64";
    return undefined;
  }
  if (platform === "linux") {
    if (arch === "arm64") return "pew2-linux-arm64";
    if (arch === "x64") return "pew2-linux-x64";
    return undefined;
  }
  if (platform === "win32") {
    // One Windows build, x64 only, and the only asset with an extension.
    return arch === "x64" ? "pew2-windows-x64.exe" : undefined;
  }
  return undefined;
}

/**
 * Whether this platform has a supervisor backend at all.
 *
 * A pre-filter, not the answer. Swapping the binary is portable; the *exit* is
 * only an update where something starts the process again, and each platform
 * gets that from a different place (`cli/service.ts` and its two siblings):
 *
 * - **darwin**: a launchd agent with `KeepAlive`.
 * - **linux**: a systemd user unit with `Restart=always` — which, unlike the
 *   `on-failure` most guides suggest, also restarts after a clean exit, and a
 *   clean exit is exactly how this updater ends the daemon.
 * - **win32**: a Scheduled Task whose repeating trigger plus `IgnoreNew`
 *   instance policy amounts to the same thing, at a one-minute granularity.
 *
 * Anything else has no way back from an exit, and must never be swapped: the
 * user would be left with a new binary, a dead daemon and no way to notice.
 */
export function hasSupervisor(platform: string): boolean {
  return platform === "darwin" || platform === "linux" || platform === "win32";
}

/**
 * Whether a supervisor is actually installed on *this* machine.
 *
 * The platform is not enough, and assuming it was is a way to take a user's
 * daemon offline for good. `pew2 serve` is a first-class command: someone can
 * run the daemon in a terminal, or from a fresh install where `pew2 setup` has
 * never registered a service — which is exactly why `install.sh` guards its own
 * restart on the plist existing. On such a machine an exit-to-update is simply
 * an exit, and the phone stays offline until a human notices.
 *
 * So the gate is the service file on disk, not the value of `process.platform`.
 */
export function supervisorInstalled(platform: string = osPlatform()): boolean {
  return hasSupervisor(platform) && serviceInstalled(platform);
}

/** Where an asset lives: a pinned tag when given, otherwise whatever is latest. */
export function assetUrl(asset: string, version?: string): string {
  const base = `https://github.com/${REPO}/releases`;
  return version
    ? `${base}/download/v${version.replace(/^v/i, "")}/${asset}`
    : `${base}/latest/download/${asset}`;
}

/**
 * The hex digest out of a `sha256sum` file.
 *
 * The published format is `<hex>  <filename>`, so the digest is the first
 * field. Anything that is not 64 hex characters is refused rather than
 * compared loosely — a truncated or HTML error page must never be read as a
 * checksum that happens not to match.
 */
export function parseChecksum(body: string): string | undefined {
  const first = body.trim().split(/\s+/)[0];
  if (!first || !/^[0-9a-f]{64}$/i.test(first)) return undefined;
  return first.toLowerCase();
}

/** Fetch a URL as bytes, or undefined on any failure at all. */
async function download(
  fetchImpl: typeof fetch,
  url: string,
  userAgent: string,
  timeoutMs: number,
): Promise<Uint8Array | undefined> {
  try {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": userAgent },
      // GitHub serves release assets as a redirect to object storage.
      redirect: "follow",
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return undefined;
    const bytes = new Uint8Array(await response.arrayBuffer());
    // A zero-length body is a failed transfer that happens to have succeeded at
    // the HTTP layer; installing it would produce a binary that cannot run.
    return bytes.byteLength > 0 ? bytes : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Download the current release and put it in place of this binary.
 *
 * On success the new version is on disk and the *old* one is still running:
 * `restartRequired` is always true, and nothing here ends the process.
 */
export async function applyUpdate(options: ApplyOptions = {}): Promise<ApplyResult> {
  const {
    version,
    fetchImpl = globalThis.fetch,
    targetPath = process.execPath,
    platform = osPlatform(),
    arch = process.arch,
    compiled = isCompiled(),
    currentVersion = CURRENT_VERSION,
    timeoutMs = DOWNLOAD_TIMEOUT_MS,
    supervised = supervisorInstalled(platform),
    renameImpl = rename,
  } = options;

  if (!supervised) {
    return {
      ok: false,
      reason: "unsupported-platform",
      // Two different situations, and telling them apart is the difference
      // between "your OS cannot do this" and "run `pew2 setup` and it will".
      detail: hasSupervisor(platform)
        ? `No pew2 service is installed, so nothing would restart the daemon ` +
          `after it exits. Run \`pew2 setup\` to install one.`
        : `${platform} has no supervisor to restart the daemon after it exits, ` +
          `so a swapped binary would never take effect.`,
    };
  }

  if (!compiled) {
    // The footgun this gate exists for: under `bun run`, execPath is the
    // developer's bun binary, and a rename here would destroy it.
    return {
      ok: false,
      reason: "not-compiled",
      detail:
        "Running from source, where the executable is bun itself. Update the " +
        "checkout with git instead.",
    };
  }

  const asset = assetName(platform, arch);
  if (!asset) {
    return { ok: false, reason: "unsupported-arch", detail: `No published build for ${arch}.` };
  }

  if (typeof fetchImpl !== "function") {
    return { ok: false, reason: "download-failed", detail: "This runtime has no fetch." };
  }

  // Checked before anything is downloaded: an install directory owned by root
  // (a Homebrew prefix, /usr/local/bin) is the ordinary case on a shared
  // machine, and spending 60MB of someone's tethered connection to discover it
  // is rude.
  const installDir = dirname(targetPath);
  try {
    await access(installDir, constants.W_OK);
  } catch {
    return {
      ok: false,
      reason: "not-writable",
      detail: `${installDir} is not writable by this process.`,
    };
  }

  const userAgent = `pew2-daemon/${currentVersion}`;
  const binaryUrl = assetUrl(asset, version);

  const checksumBody = await download(fetchImpl, `${binaryUrl}.sha256`, userAgent, timeoutMs);
  if (!checksumBody) {
    // Required, not best effort, for the same reason install.sh spells out:
    // whoever serves the binary could otherwise disable the check by serving
    // one file less.
    return {
      ok: false,
      reason: "checksum-missing",
      detail: "That release published no checksum, so the download cannot be trusted.",
    };
  }
  const expected = parseChecksum(new TextDecoder().decode(checksumBody));
  if (!expected) {
    return { ok: false, reason: "checksum-missing", detail: "The published checksum is unreadable." };
  }

  const bytes = await download(fetchImpl, binaryUrl, userAgent, timeoutMs);
  if (!bytes) {
    return { ok: false, reason: "download-failed", detail: `Could not download ${asset}.` };
  }

  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== expected) {
    // Nothing has touched the install directory at this point, so there is
    // nothing to roll back: refusing is simply returning.
    return {
      ok: false,
      reason: "checksum-mismatch",
      detail: `Downloaded bytes do not match the published checksum (expected ${expected}, got ${actual}).`,
    };
  }

  // Staged beside the target so the rename cannot cross a filesystem. A dot
  // prefix keeps a half-written file from looking like a command on PATH.
  let staging: string | undefined;
  // Where the outgoing binary was parked, on a platform that needs it moved out
  // of the way first. Cleaned up on success, restored on failure.
  let parked: string | undefined;
  try {
    const stagingDir = await mkdtemp(join(installDir, ".pew2-update-"));
    staging = join(stagingDir, "pew2");
    await writeFile(staging, bytes);
    // Before the rename, not after: a moment where the binary exists but is not
    // executable is a moment where a shell finds it and cannot run it.
    await chmod(staging, 0o755);

    if (platform === "win32") {
      // Windows will not let a running executable be replaced or unlinked, but
      // it *will* let one be renamed. So the outgoing binary is moved aside to
      // free its name, and the new one takes it. The parked copy cannot be
      // deleted while it is still running, which is why it is left for the next
      // update to sweep rather than removed here.
      parked = `${targetPath}.old-${Date.now()}`;
      await renameImpl(targetPath, parked);
    }

    await renameImpl(staging, targetPath);
    await rm(stagingDir, { recursive: true, force: true });
    staging = undefined;
  } catch (error) {
    if (staging) {
      // Leave nothing behind in a directory that is on the user's PATH.
      await rm(dirname(staging), { recursive: true, force: true }).catch(() => {});
    }
    // The window between parking the old binary and the new one landing is the
    // only moment where `pew2` does not exist at all. If the second rename
    // failed, put it back — an aborted update must leave a working command, not
    // a machine with no daemon and a file named `pew2.old-1760000000000`.
    if (parked) {
      await rename(parked, targetPath).catch(() => {});
    }
    return {
      ok: false,
      reason: "install-failed",
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    ok: true,
    previous: currentVersion,
    installed: version ?? "latest",
    path: targetPath,
    restartRequired: true,
  };
}

/**
 * Whether this build could ever update itself.
 *
 * Cheap enough to call before scheduling anything, and the honest answer to
 * "should the UI offer an update button" on a platform that has no supervisor.
 */
export function canSelfUpdate(
  options: {
    platform?: string;
    arch?: string;
    compiled?: boolean;
    /** Overridden in tests, which must not depend on this machine's plist. */
    supervised?: boolean;
  } = {},
): boolean {
  const {
    platform = osPlatform(),
    arch = process.arch,
    compiled = isCompiled(),
    supervised = supervisorInstalled(platform),
  } = options;
  // All three, and the supervisor is the one that is easy to get wrong twice:
  // `assetName` alone would answer true on Linux and Windows, and the platform
  // alone would answer true for a macOS daemon started by hand in a terminal,
  // which nothing would restart.
  return compiled && supervised && assetName(platform, arch) !== undefined;
}
