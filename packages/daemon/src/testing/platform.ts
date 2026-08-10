/**
 * Platform facts the tests have to respect, in one place.
 *
 * These exist because CI became honest. Until a Windows job ran, every test
 * quietly assumed POSIX — an extensionless file is executable, permission bits
 * mean something, paths start with `/` — and 20 of them failed the first time
 * real Windows saw them. None of those failures was a product bug; all of them
 * were the tests describing one operating system while claiming to describe the
 * code.
 *
 * The point of the helpers is that a test says what it means. `fakeExecutable`
 * says "something runnable lives here", not "a file with mode 0755", so it
 * stays true on a platform where the second sentence is meaningless.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export const WINDOWS = process.platform === "win32";

/**
 * Do permission bits mean anything here?
 *
 * On Windows they do not. `chmod` is accepted and very nearly ignored: NTFS
 * uses ACLs, `stat().mode` reports a synthesised value, and asking whether a
 * file is "world-readable" has no answer in those terms. A test asserting
 * `mode & 0o077 === 0` there is not testing the daemon, it is testing Node's
 * emulation \u2014 so those assertions are guarded rather than deleted, and the
 * behaviour they cover still runs everywhere it is real.
 */
export const POSIX_MODES = !WINDOWS;

/**
 * Put something on PATH that `findOnPath` will accept.
 *
 * A bare `agent` file is executable on POSIX and inert on Windows, where the
 * name has to carry a PATHEXT suffix. Tests that only need "this command
 * exists" were writing the POSIX shape by hand, so on Windows they were
 * asserting against an agent the resolver was right to ignore.
 *
 * Returns the full path actually written, since that is what resolution will
 * report back and a caller may want to compare against.
 */
export async function fakeExecutable(dir: string, command: string): Promise<string> {
  if (WINDOWS) {
    const path = join(dir, `${command}.cmd`);
    await writeFile(path, "@ECHO OFF\r\nEXIT /B 0\r\n");
    return path;
  }
  const path = join(dir, command);
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return path;
}

/**
 * Can a test assert against a literal POSIX path?
 *
 * Some tests are about path *building* and spell their expectations out:
 * `/tmp/x/logs/daemon.log`. Those cannot hold on Windows, where the same code
 * correctly produces `\tmp\x\logs\daemon.log` and `resolve` adds a drive letter.
 * The behaviour is real and worth pinning; the literal is not portable. So the
 * assertion is guarded rather than rewritten into something so separator-
 * agnostic it stops saying anything.
 *
 * Only for hard-coded path literals. Anything that can be written with `join`
 * should be, and then it runs everywhere.
 */
export const POSIX_PATHS = !WINDOWS;
