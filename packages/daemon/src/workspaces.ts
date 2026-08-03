/**
 * Finding a project to work in when the agent has never seen one.
 *
 * The drawer's project list is folded out of an agent's own past sessions, which
 * is exactly right for an agent you already use and useless for one you have
 * just installed: no history, no projects, no way in. The phone cannot solve
 * this on its own — the directories are on the *desktop*, and a native file
 * picker on iOS hands back a security-scoped bookmark that means nothing to a
 * daemon on another machine. So the daemon does the looking and the phone
 * renders the answer, which is the same shape as everything else here.
 *
 * Two operations, deliberately separate:
 *
 *   `discoverRepos` — the good guesses. Scans a few likely roots for git
 *                     checkouts and returns them newest first. This is what the
 *                     phone shows first, because tapping down from `/` on a
 *                     touchscreen is miserable.
 *   `listDirectory` — the escape hatch, for a project the scan did not find.
 *
 * Both are read-only, and both refuse to look outside `browsableRoots()`. The
 * pairing token is a bearer secret over a public relay: a stolen one must not
 * become "enumerate this person's entire filesystem".
 */
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

/** A directory the user could start a conversation in. */
export interface WorkspaceEntry {
  path: string;
  name: string;
  /** A git checkout. Ranked above plain directories, and labelled in the UI. */
  repo: boolean;
  /** Last modification, ISO. Used to rank; may be absent if unreadable. */
  updatedAt?: string;
}

/**
 * How deep to look for repositories.
 *
 * Three levels covers `~/code/acme/api` — an org folder inside a code folder —
 * which is where most checkouts actually live. Deeper multiplies the directory
 * count for a rapidly worsening hit rate, and this runs while someone waits.
 */
const SCAN_DEPTH = 3;

/** A ceiling on the scan, so an enormous home directory cannot hang the daemon. */
const SCAN_LIMIT = 4_000;

/**
 * Never worth descending into.
 *
 * `node_modules` alone can hold tens of thousands of directories and never
 * contains a project the user means. The dotfile rule is separate: `.config` and
 * friends are noise in a project picker, but a dotted directory the user names
 * explicitly is still browsable.
 */
const SKIP = new Set([
  "node_modules",
  ".git",
  "vendor",
  "target",
  "dist",
  "build",
  "Library",
  "Applications",
  ".Trash",
  "venv",
  ".venv",
  "__pycache__",
  ".next",
  ".cache",
  "Pods",
]);

/**
 * Where browsing may go.
 *
 * The user's home directory, and anything they explicitly allow. Home rather
 * than `/` because that is where projects live and because the difference
 * matters: `/` would expose every other account on a shared machine, plus system
 * directories that are nobody's project.
 *
 * `PEW2_BROWSE_ROOTS` exists for the volume-of-code-on-an-external-disk case,
 * and is opt-in for the same reason `PEW2_IMAGE_ROOTS` is.
 */
export function browsableRoots(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string[] {
  const roots = [resolve(home)];
  for (const extra of (env.PEW2_BROWSE_ROOTS ?? "").split(":")) {
    if (extra.trim()) roots.push(resolve(extra.trim()));
  }
  return roots;
}

/** True when `path` is `root` or sits underneath it. */
function isInside(path: string, root: string): boolean {
  const base = resolve(root);
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

/**
 * Roots as the filesystem actually names them.
 *
 * A path is compared after `realpath`, so the roots have to be resolved the same
 * way or the comparison is between two different spellings of one directory. On
 * macOS `/tmp` and `/var/folders/…` are symlinks into `/private`, and a home
 * directory can be one too on a machine with relocated accounts — in which case
 * every path under it would be refused as "outside the allowlist".
 *
 * An unresolvable root is kept as written rather than dropped: it may simply not
 * exist yet, and silently discarding it would widen nothing but confuse later.
 */
async function realRoots(roots: string[]): Promise<string[]> {
  return Promise.all(
    roots.map(async (root) => {
      try {
        return resolve(await realpath(root));
      } catch {
        return resolve(root);
      }
    }),
  );
}

/**
 * Resolve a client-supplied path, or reject it.
 *
 * Symlinks are followed *before* the check, exactly as image serving does: a
 * link inside home pointing at `/etc` is otherwise a one-line bypass of every
 * root in the list. A path that does not exist yet cannot be browsed, so a
 * failed realpath is a refusal rather than a fallback to the unresolved string.
 */
export async function resolveBrowsePath(
  raw: string,
  roots: string[] = browsableRoots(),
  home: string = homedir(),
): Promise<string | undefined> {
  const expanded = raw === "~" ? home : raw.startsWith("~/") ? join(home, raw.slice(2)) : raw;
  if (!isAbsolute(expanded)) return undefined;

  let real: string;
  try {
    real = resolve(await realpath(expanded));
  } catch {
    return undefined;
  }
  const bases = await realRoots(roots);
  return bases.some((root) => isInside(real, root)) ? real : undefined;
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The directories inside `path`, alphabetically.
 *
 * Files are omitted: this picker chooses a working directory, and a list padded
 * with source files would bury the handful of folders that can actually be
 * picked. Hidden directories are omitted for the same reason, with `.git`
 * detection preserved separately so a repo still reads as one.
 */
export async function listDirectory(
  path: string,
  options: { roots?: string[]; home?: string; limit?: number } = {},
): Promise<{ path: string; parent?: string; entries: WorkspaceEntry[] } | undefined> {
  const home = options.home ?? homedir();
  // Read once: `browsableRoots()` consults the environment, and calling it three
  // times in one listing could observe three different answers.
  const roots = options.roots ?? browsableRoots();
  const resolved = await resolveBrowsePath(path, roots, home);
  if (!resolved || !(await isDirectory(resolved))) return undefined;

  let names: string[];
  try {
    names = await readdir(resolved);
  } catch {
    // Unreadable is not an error worth failing the request over — an empty
    // listing says the same thing to the user without a red banner.
    return { path: resolved, parent: await parentOf(resolved, roots), entries: [] };
  }

  const entries: WorkspaceEntry[] = [];
  for (const name of names.sort((a, b) => a.localeCompare(b))) {
    if (name.startsWith(".") || SKIP.has(name)) continue;
    if (entries.length >= (options.limit ?? 500)) break;

    const child = join(resolved, name);
    if (!(await isDirectory(child))) continue;
    entries.push({
      path: child,
      name,
      repo: await isRepo(child),
      updatedAt: await modifiedAt(child),
    });
  }

  return { path: resolved, parent: await parentOf(resolved, roots), entries };
}

/**
 * The directory to go "up" to, or undefined at a root.
 *
 * Returning a parent outside the allowlist would offer a row that can only fail
 * when tapped, so the boundary is enforced here rather than left to the client.
 */
async function parentOf(path: string, roots: string[]): Promise<string | undefined> {
  const bases = await realRoots(roots);
  if (bases.some((root) => root === path)) return undefined;
  const parent = dirname(path);
  if (parent === path) return undefined;
  return bases.some((root) => isInside(parent, root)) ? parent : undefined;
}

async function isRepo(path: string): Promise<boolean> {
  try {
    // `.git` is a directory in a normal checkout and a file in a worktree or
    // submodule; both are real repositories to the user.
    await stat(join(path, ".git"));
    return true;
  } catch {
    return false;
  }
}

async function modifiedAt(path: string): Promise<string | undefined> {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return undefined;
  }
}

/**
 * Git checkouts under the browsable roots, most recently touched first.
 *
 * Breadth-first so shallow, obvious locations (`~/projects/api`) are found
 * before deep ones, and so the scan limit truncates the least likely candidates
 * rather than an arbitrary branch. A repository is never descended into: its
 * submodules and vendored copies are not what the user meant, and skipping them
 * is most of what keeps this fast.
 */
export async function discoverRepos(
  options: { roots?: string[]; depth?: number; limit?: number; scanLimit?: number } = {},
): Promise<WorkspaceEntry[]> {
  const roots = options.roots ?? browsableRoots();
  const maxDepth = options.depth ?? SCAN_DEPTH;
  const scanLimit = options.scanLimit ?? SCAN_LIMIT;
  // Resolved once, and compared against below. The scan follows symlinks, so
  // containment has to be re-checked at every step — not just on the way in.
  const bases = await realRoots(roots);

  const found: WorkspaceEntry[] = [];
  const seen = new Set<string>();
  let queue: { path: string; depth: number }[] = roots.map((root) => ({
    path: resolve(root),
    depth: 0,
  }));
  let scanned = 0;

  while (queue.length > 0 && scanned < scanLimit) {
    const next: { path: string; depth: number }[] = [];

    for (const { path, depth } of queue) {
      if (scanned >= scanLimit) break;
      scanned++;

      // Symlinked directories can form cycles, and a repo reachable by two paths
      // should appear once.
      let real: string;
      try {
        real = resolve(await realpath(path));
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);

      // The same containment check `resolveBrowsePath` makes, and it has to be
      // here too: a symlink *inside* the roots — `~/code -> /Volumes/work` — is
      // followed by the walk above, so without this the scan happily reports
      // repositories from anywhere on the machine. They would then be echoed to
      // the phone, remembered as offerable, and accepted as a working directory,
      // while `listDirectory` refused those very paths — rows that cannot even
      // be opened.
      if (!bases.some((root) => isInside(real, root))) continue;

      if (await isRepo(real)) {
        found.push({
          path: real,
          name: basename(real),
          repo: true,
          updatedAt: await modifiedAt(real),
        });
        // Not descended into: submodules and vendored checkouts are not the
        // project the user is looking for.
        continue;
      }

      if (depth >= maxDepth) continue;

      let names: string[];
      try {
        names = await readdir(real);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.startsWith(".") || SKIP.has(name)) continue;
        const child = join(real, name);
        if (await isDirectory(child)) next.push({ path: child, depth: depth + 1 });
      }
    }

    queue = next;
  }

  // Most recently touched first: the answer to "which project" is nearly always
  // something worked on lately, and a phone shows about six rows without
  // scrolling. Undated entries sort last rather than being dropped.
  found.sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""));
  return found.slice(0, options.limit ?? 40);
}
