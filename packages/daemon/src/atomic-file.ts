/**
 * Writing a file so that a reader never sees half of one.
 *
 * `writeFile` truncates first and then fills, so a daemon killed mid-write — or
 * killed by the machine going to sleep — leaves a file that parses as corrupt
 * and is read as "no preferences at all". Every store here is read-modify-write
 * over a whole document, so that is not one lost setting but all of them.
 *
 * Renaming is atomic within a filesystem: a reader sees either the old file or
 * the new one. It also settles concurrent writers, who would otherwise
 * interleave into a single file descriptor — with a rename the last writer wins
 * cleanly, which is the same answer read-modify-write was already going to give.
 */
import { rename, writeFile } from "node:fs/promises";

/**
 * Distinguishes two writes racing inside one process.
 *
 * The pid alone is not enough: `session.config` and a session opening can be
 * writing at the same moment, and sharing a temp path would put both documents
 * into one file.
 */
let sequence = 0;

/**
 * Write `data` to `path` via a temporary file in the same directory.
 *
 * Same directory because rename is only atomic within a filesystem, and a temp
 * directory is often a different one.
 *
 * @param mode Permissions for the finished file. Defaults to owner-only: these
 * hold conversation state and user choices, and the process umask would
 * otherwise decide who else on the machine can read them.
 */
export async function writeFileAtomic(
  path: string,
  data: string,
  mode = 0o600,
): Promise<void> {
  const temp = `${path}.${process.pid}.${sequence++}.tmp`;
  await writeFile(temp, data, { encoding: "utf8", mode });
  await rename(temp, path);
}
