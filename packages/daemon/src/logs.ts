/**
 * Keeping the daemon's log from growing without limit.
 *
 * Under launchd the daemon's stdout *is* a file, opened once by launchd and
 * appended to for the life of the process. Nothing ever truncates it, so a
 * machine that runs pew2 for months accumulates a log nobody reads until it is
 * the reason a disk is full.
 *
 * Rotation happens at startup and then on a timer, because a daemon that is
 * never restarted is exactly the one whose log runs away — a machine left
 * running for weeks under launchd never reaches a second startup, and the
 * ceiling below went unenforced for the whole of it.
 *
 *   - The file is truncated *in place*, never renamed. launchd holds an open
 *     descriptor to the path it opened; renaming the file leaves that
 *     descriptor pointing at the renamed inode, so the running daemon would go
 *     on writing to `daemon.log.1` while `daemon.log` sat empty.
 *   - Truncating a file the daemon is still writing to is safe only because
 *     every supervisor opens it in append mode (launchd `StandardOutPath`,
 *     systemd `append:`, `>>` under Task Scheduler): each write lands at the
 *     current end of file, so the next line after a truncation goes to the new
 *     one instead of leaving a hole of NUL bytes behind it. A line being
 *     written at that instant can still be clipped, which is the right price
 *     for the file staying bounded.
 *   - The tail is kept rather than the head. When something has just gone
 *     wrong, the interesting lines are the most recent ones.
 *   - Failure is never fatal. A daemon that refuses to start because it could
 *     not tidy a log file has turned a housekeeping problem into an outage.
 */
import { open, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Rotate above this size. Large enough for real history, small enough to read. */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** How much of the tail survives a rotation. */
export const KEEP_LOG_BYTES = 512 * 1024;

export interface RotateResult {
  rotated: boolean;
  before: number;
  after: number;
}

/**
 * Truncate `path` to its last `keep` bytes if it exceeds `max`.
 *
 * Returns what happened rather than logging it: the caller owns the console,
 * and a rotation is worth one line at startup, not a stack trace.
 */
export async function rotateLog(
  path: string,
  max: number = MAX_LOG_BYTES,
  keep: number = KEEP_LOG_BYTES,
): Promise<RotateResult> {
  // No initialiser: every path out of the catch returns, so a starting value
  // here would only ever be overwritten or unused.
  let before: number;
  try {
    before = (await stat(path)).size;
  } catch {
    // No log yet — the common case on a first run.
    return { rotated: false, before: 0, after: 0 };
  }

  if (before <= max) return { rotated: false, before, after: before };

  try {
    const handle = await open(path, "r");
    try {
      const tail = Buffer.alloc(Math.min(keep, before));
      // Read the final `keep` bytes directly rather than loading the whole
      // file: the file being too big is the entire reason we are here.
      const { bytesRead } = await handle.read(tail, 0, tail.length, before - tail.length);
      // Drop the leading partial line so the rotated log still starts cleanly.
      const newline = tail.indexOf(0x0a);
      const start = newline >= 0 && newline < bytesRead - 1 ? newline + 1 : 0;
      await writeFile(path, tail.subarray(start, bytesRead));
      return { rotated: true, before, after: bytesRead - start };
    } finally {
      await handle.close();
    }
  } catch {
    // Permissions, a vanished file, a full disk: none of these are worth
    // failing a daemon start over.
    return { rotated: false, before, after: before };
  }
}

/**
 * Where the daemon's logs live.
 *
 * Defined here rather than in the CLI because the service definition and the
 * rotation must agree on the path exactly — two copies of this join would
 * rotate one file while launchd wrote to another.
 */
export function logDir(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(env.PEW2_HOME ?? join(home, ".pew2"), "logs");
}

/**
 * The daemon's two log files, in the order the service definition assigns them.
 *
 * Both are rotated. stderr is the one that actually runs away: a provider that
 * fails on every probe writes a stack trace each time, which is precisely the
 * situation where nobody is watching the file grow.
 */
export function daemonLogPaths(env: NodeJS.ProcessEnv = process.env, home?: string): string[] {
  const dir = logDir(env, home);
  return [join(dir, "daemon.log"), join(dir, "daemon.error.log")];
}

/** How often a running daemon re-checks its logs against `MAX_LOG_BYTES`. */
export const ROTATE_INTERVAL_MS = 60 * 60 * 1000;

/**
 * Keep the daemon's logs under the ceiling for as long as it runs.
 *
 * The startup pass alone bounds a log by *restarts*, not by size, and the
 * daemon this is written for is a launchd service that goes weeks without one.
 * A provider failing its capability probe writes a stack trace every few
 * minutes into a file nobody is watching.
 *
 * @returns A function that stops the timer.
 */
export function startLogRotation({
  paths = daemonLogPaths(),
  intervalMs = ROTATE_INTERVAL_MS,
  max = MAX_LOG_BYTES,
  keep = KEEP_LOG_BYTES,
  onRotate,
}: {
  paths?: string[];
  intervalMs?: number;
  max?: number;
  keep?: number;
  onRotate?: (path: string, result: RotateResult) => void;
} = {}): () => void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        for (const path of paths) {
          // Sequential, not `Promise.all`: the two files share a disk and this
          // is housekeeping, so there is nothing to win by doing both at once.
          const result = await rotateLog(path, max, keep);
          if (result.rotated) onRotate?.(path, result);
        }
      } catch {
        // `rotateLog` already swallows its own failures, so the only thing that
        // can throw here is the caller's `onRotate`. Nothing would catch it: a
        // rejection out of an interval callback is unhandled by definition, and
        // this daemon holds every live session on the machine. Losing one
        // housekeeping pass is the cheaper of the two outcomes by a distance.
      }
    })();
  }, intervalMs);
  // Housekeeping must never be the reason the process stays alive.
  timer.unref?.();
  return () => clearInterval(timer);
}
