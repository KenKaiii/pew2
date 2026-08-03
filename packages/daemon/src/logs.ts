/**
 * Keeping the daemon's log from growing without limit.
 *
 * Under launchd the daemon's stdout *is* a file, opened once by launchd and
 * appended to for the life of the process. Nothing ever truncates it, so a
 * machine that runs pew2 for months accumulates a log nobody reads until it is
 * the reason a disk is full.
 *
 * Rotation therefore happens at startup, which is the only moment the file can
 * be resized safely:
 *
 *   - The file is truncated *in place*, never renamed. launchd holds an open
 *     descriptor to the path it opened; renaming the file leaves that
 *     descriptor pointing at the renamed inode, so the running daemon would go
 *     on writing to `daemon.log.1` while `daemon.log` sat empty.
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
  let before = 0;
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
