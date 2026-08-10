/**
 * Ask GitHub whether a newer daemon has been released.
 *
 * Step one of self-update, and deliberately only that: this module reads a
 * version number and compares it. It downloads nothing, writes nothing, and
 * exits nothing. Everything that could damage a working install lives behind a
 * later step, so this half can be turned on without risk.
 *
 * ## Which platforms could ever act on the answer
 *
 * Updating a running daemon means replacing a file and then ending the process,
 * because `mv` swaps a directory entry while the running program keeps
 * executing the old inode — the bug fixed in `e7717f9`, where every curl update
 * landed on disk and changed nothing until the machine rebooted. Ending the
 * process is only survivable where something restarts it. Checked, not assumed:
 *
 * - **macOS — yes.** `cli/service.ts` installs `~/Library/LaunchAgents/
 *   dev.pew2.daemon.plist` with `KeepAlive: true`, so launchd relaunches the
 *   daemon whenever it exits. The daemon never has to re-exec itself; exiting
 *   at an idle moment is the whole mechanism, and launchd's 10s restart
 *   throttle is the only pause the user could notice.
 * - **Linux — no.** `serviceInstalled()` is `platform() === "darwin"`, and the
 *   module's own header says Linux "gets a clear message rather than a broken
 *   unit file". No systemd unit is written anywhere in this repository.
 * - **Windows — no.** `install.ps1` puts the binary on PATH and does not
 *   register a service, a scheduled task, or a Run key. It has no restart step
 *   at all, which is why the macOS-only restart in `install.sh` has no twin.
 *
 * So exit-to-update is a macOS strategy. On Linux and Windows a daemon that
 * exits to update simply stays dead, taking the user's phone offline until they
 * notice and start it by hand — strictly worse than not updating. Those
 * platforms get told an update exists and nothing more, which is what makes
 * this check's return value useful everywhere while the action stays gated.
 *
 * Pure and injectable: `fetch` and the current version are parameters, so the
 * tests drive it without a network and the daemon is never a captive of
 * GitHub's uptime.
 */
// Imported rather than read from disk: this file ends up inside a compiled
// binary, where there is no package.json beside it to read. Same reason, and
// the same path depth, as `cli/index.ts`.
import pkg from "../../package.json" with { type: "json" };

/** The version this build was cut from. */
export const CURRENT_VERSION = (pkg as { version: string }).version;

/** Where releases are published. `install.sh` resolves the same repository. */
export const RELEASE_API_URL = "https://api.github.com/repos/KenKaiii/pew2/releases/latest";

/**
 * How long to wait on GitHub before giving up.
 *
 * A daemon must never be held open by a check nobody asked for: a socket that
 * connects and then stalls would otherwise hang until the OS gave up, which on
 * some networks is minutes. Not finding out about an update is free; blocking
 * the process that carries the user's session is not.
 */
export const CHECK_TIMEOUT_MS = 10_000;

export interface UpdateCheck {
  /** The version running now. */
  current: string;
  /** The version published as latest, with any `v` prefix stripped. */
  latest: string;
  /** Whether `latest` is strictly newer than `current`. */
  newer: boolean;
}

/** Just enough of GitHub's release payload to name a version. */
interface ReleasePayload {
  tag_name?: unknown;
}

export interface CheckOptions {
  /** Overridden in tests; defaults to the version compiled into this build. */
  currentVersion?: string;
  /** Injected so tests never touch the network. */
  fetchImpl?: typeof fetch;
  /** Overridden in tests to avoid a real timer. */
  timeoutMs?: number;
}

/**
 * A version as comparable numbers, or `undefined` if it is not one.
 *
 * Releases are tagged `v*`, so the prefix is expected rather than tolerated.
 * Anything after a `-` is a prerelease marker and is dropped here; see
 * `compareVersions` for why that is safe for this use.
 */
function parseVersion(raw: string): number[] | undefined {
  const cleaned = raw.trim().replace(/^v/i, "");
  if (!cleaned) return undefined;
  // Build metadata (`+sha`) and prerelease (`-beta.1`) are not part of the
  // ordering this module needs.
  const core = cleaned.split(/[-+]/)[0]!;
  const parts = core.split(".");
  if (parts.length === 0 || parts.length > 4) return undefined;
  const numbers: number[] = [];
  for (const part of parts) {
    // `Number("")` is 0 and `Number("1a")` is NaN; both must be refused, or
    // "1..2" and "1.2a" would compare as though they meant something.
    if (!/^\d+$/.test(part)) return undefined;
    numbers.push(Number(part));
  }
  return numbers;
}

/**
 * Order two versions: negative if `a` is older, 0 if equal, positive if newer.
 *
 * Segment-wise and numeric, because the obvious string comparison gets this
 * wrong exactly when it matters: `"0.9.10" < "0.9.9"` lexically, so the tenth
 * patch release of a series would look like a downgrade and never install.
 *
 * Returns `undefined` when either side is not a version at all, so a caller can
 * tell "older" from "unanswerable" rather than treating a broken tag as a
 * reason to act.
 *
 * A prerelease compares equal to its release (`1.2.0-rc1` vs `1.2.0`), which is
 * deliberate: GitHub's "latest release" excludes prereleases, so the only way
 * one arrives here is if it was published as latest on purpose, and offering a
 * user a downgrade-to-rc is worse than offering nothing.
 */
export function compareVersions(a: string, b: string): number | undefined {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return undefined;
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i++) {
    // A missing segment is zero: 1.2 and 1.2.0 are the same release.
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * Look up the latest published release.
 *
 * Never throws and never rejects. Every failure — no network, a rate-limited
 * 403, a 404 from a repository with no releases yet, malformed JSON, a tag that
 * is not a version — answers `null`, meaning "no usable answer", which is not
 * the same as "you are up to date". A background check that could take the
 * daemon down with it would be a worse bug than the staleness it exists to fix.
 */
export async function checkForUpdate(options: CheckOptions = {}): Promise<UpdateCheck | null> {
  const {
    currentVersion = CURRENT_VERSION,
    fetchImpl = globalThis.fetch,
    timeoutMs = CHECK_TIMEOUT_MS,
  } = options;

  if (typeof fetchImpl !== "function") return null;

  try {
    const response = await fetchImpl(RELEASE_API_URL, {
      headers: {
        // GitHub refuses requests without one, and the version makes an
        // unexpected traffic pattern traceable to a build.
        "User-Agent": `pew2-daemon/${currentVersion}`,
        Accept: "application/vnd.github+json",
      },
      // Bounded rather than open-ended; see CHECK_TIMEOUT_MS.
      signal: AbortSignal.timeout(timeoutMs),
    });

    // 403 is the rate limit, 404 a repository with no release yet. Both are
    // ordinary, and neither is a reason to log or retry aggressively.
    if (!response.ok) return null;

    const payload = (await response.json()) as ReleasePayload;
    const tag = payload?.tag_name;
    if (typeof tag !== "string") return null;

    const latest = tag.trim().replace(/^v/i, "");
    const order = compareVersions(latest, currentVersion);
    // An unparseable tag is not an update. Someone publishing a release named
    // "nightly" must not be read as a version the daemon should move to.
    if (order === undefined) return null;

    return { current: currentVersion, latest, newer: order > 0 };
  } catch {
    // Offline, DNS failure, TLS failure, timeout, or a body that was not JSON.
    // All of them mean the same thing to a caller: ask again later.
    return null;
  }
}
