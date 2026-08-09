/**
 * Making sure an agent process never outlives the daemon that spawned it.
 *
 * Two separate leaks, and they need two separate mechanisms.
 *
 * **The wrapper.** Five bundled providers launch through `npx`, so the process
 * this daemon owns is a launcher and the actual agent is its child. Killing the
 * wrapper reparents the agent to pid 1, where nothing will ever collect it.
 * Every child is therefore spawned `detached` on POSIX, which gives it its own
 * process group, and killed by *group* — the wrapper and everything under it.
 * Windows has no process groups and `detached` there means something close to
 * the opposite (a child that outlives its parent by design), so it is never set
 * on win32 and `taskkill /T` walks the tree instead. Same split as Playwright's
 * process launcher, for the same reason.
 *
 * **The hard death.** `closeAll()` on SIGTERM handles an orderly stop, but a
 * daemon killed with SIGKILL, OOM-ed, or lost to a panic runs no handler at
 * all, and its agents survive as orphans holding hundreds of MB each. No signal
 * can fix that from inside the dying process, so instead every spawn is
 * recorded to disk and the *next* daemon sweeps what the last one left: an
 * entry whose owning daemon is gone is an orphan by definition.
 *
 * Pid reuse is the obvious hazard in a registry like this, so a recorded pid is
 * only ever signalled when the identity still on it matches the one recorded at
 * spawn. A stale entry then costs nothing; killing an innocent process that
 * inherited the number would cost a lot. Both sides of that comparison come
 * from the OS rather than the manifest, for the same reason: the manifest says
 * `goose acp` while the kernel says `/opt/homebrew/bin/goose acp`, and matching
 * the manifest text would have quietly spared every orphan it was written for.
 */
import { execFile, execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { writeFileAtomic } from "./atomic-file.js";
import { userProvidersDir } from "./providers/registry.js";

const run = promisify(execFile);

const WINDOWS = process.platform === "win32";

/**
 * Whether a spawned agent should get its own process group.
 *
 * False on Windows, where the flag detaches a child into its own console and
 * lets it survive the parent — the leak this module exists to prevent.
 */
export const DETACH_CHILDREN = !WINDOWS;

/** How long a child gets to exit on its own before it is killed outright. */
const TERMINATE_GRACE_MS = 2_000;

export interface ChildRecord {
  /** The spawned process, which on POSIX is also its process group id. */
  pid: number;
  /** The daemon that owns it. Dead owner, orphaned child. */
  ownerPid: number;
  providerId: string;
  /**
   * What the OS reported for this pid at spawn, for the pid-reuse check.
   *
   * Not the manifest's `command args`: PATH resolution and launcher rewriting
   * mean the two rarely match, and a check that never matches kills nothing.
   */
  command: string;
  startedAt: number;
}

function registryPath(env: NodeJS.ProcessEnv): string {
  return join(dirname(userProvidersDir(env)), "children.json");
}

async function readRegistry(env: NodeJS.ProcessEnv): Promise<ChildRecord[]> {
  try {
    const parsed = JSON.parse(await readFile(registryPath(env), "utf8"));
    return Array.isArray(parsed) ? (parsed as ChildRecord[]) : [];
  } catch {
    // Missing or corrupt means "nothing known to clean up". A bookkeeping file
    // must never be able to stop a session from starting.
    return [];
  }
}

/**
 * Serialises the read-modify-write below.
 *
 * Sessions start concurrently, and two interleaved register calls would drop
 * one of the entries — the one process nobody would then know to kill.
 */
let queue: Promise<void> = Promise.resolve();

function enqueue(
  env: NodeJS.ProcessEnv,
  mutate: (records: ChildRecord[]) => ChildRecord[],
): Promise<void> {
  queue = queue.then(async () => {
    try {
      await writeFileAtomic(registryPath(env), JSON.stringify(mutate(await readRegistry(env))));
    } catch {
      // Best effort: the registry only improves recovery after a crash, so
      // failing to write it must not fail the spawn it was describing.
    }
  });
  return queue;
}

/**
 * Children spawned by *this* process, still running.
 *
 * The registry on disk is for the next daemon; this is for the current one's
 * own shutdown, where reading a file back is both slower and less certain than
 * the list it has been keeping all along.
 */
const owned = new Set<number>();

/**
 * @param fallbackCommand What the provider was asked to run, used only if `ps`
 * cannot be read — by which point the child is almost certainly already gone.
 */
export async function registerChild(
  { pid, providerId, fallbackCommand }: { pid: number; providerId: string; fallbackCommand: string },
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  owned.add(pid);
  const command = (await identityOf(pid)) ?? fallbackCommand;
  // An agent that died during that read — a bad flag, a missing key — has
  // already been unregistered by its exit handler, and writing the entry now
  // would leave a record no later sweep can ever match or remove.
  if (!owned.has(pid)) return;

  const entry: ChildRecord = {
    pid,
    providerId,
    command,
    ownerPid: process.pid,
    startedAt: Date.now(),
  };
  await enqueue(env, (records) => [...records.filter((r) => r.pid !== entry.pid), entry]);
}

export function unregisterChild(
  pid: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  owned.delete(pid);
  return enqueue(env, (records) => records.filter((r) => r.pid !== pid));
}

/**
 * SIGKILL every child of this process that is still up.
 *
 * The last step of shutdown, and the reason it exists: `close()` sends SIGTERM
 * and schedules an escalation, but that timer dies with the daemon a moment
 * later, so an agent that declines to honour SIGTERM would otherwise survive
 * until some future daemon start happened to sweep it. Synchronous on purpose —
 * anything awaited here races `process.exit`.
 */
export function killOwnedChildren(): number[] {
  const killed: number[] = [];
  // No pid-reuse check needed here, unlike the sweep: a child stays in this set
  // until its `exit` event, and until then it is at worst a zombie this process
  // has not reaped — the number cannot have been handed to anyone else.
  for (const pid of owned) {
    if (!alive(pid)) continue;
    signalTree(pid, "SIGKILL");
    killed.push(pid);
  }
  owned.clear();
  return killed;
}

// Installed on import rather than by each entry point, because there are three
// that can spawn an agent — the WebSocket server, the one-shot JSON daemon, and
// the CLI's probe and `providers verify` — and every one of them reaches this
// module through `connectProvider`. Registering it here is what makes "no agent
// outlives its daemon" true of all of them instead of whichever was remembered.
// 'exit' is the only hook every ending shares: signals, a fatal error, an
// explicit `process.exit`, or the loop simply draining. Nothing owned means
// nothing happens, so the cost on a process that never spawns one is a no-op.
process.on("exit", () => killOwnedChildren());

function alive(pid: number): boolean {
  try {
    // Signal 0 performs the permission and existence checks without delivering.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to someone else — not ours to kill,
    // but definitely not free to reuse either.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * How the OS identifies whatever is running on `pid` right now, or undefined if
 * nothing is.
 *
 * Recorded at spawn and compared again before any kill, which is the whole
 * defence against pid reuse. POSIX gives the full command line; Windows only
 * the image name, a weaker check that still separates a stray `node.exe` from
 * an unrelated process that inherited the number.
 */
async function identityOf(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = WINDOWS
      ? await run("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"])
      : await run("ps", ["-p", String(pid), "-o", "command="]);
    const line = stdout.trim();
    // `tasklist` answers with a success exit code and a prose "no tasks" line
    // when nothing matches, so an empty result is not the only miss.
    if (line.length === 0 || (WINDOWS && !line.startsWith('"'))) return undefined;
    return WINDOWS ? line.split(",")[0]!.replaceAll('"', "") : line;
  } catch {
    return undefined;
  }
}

/**
 * Signal a process and everything under it.
 *
 * A negative pid addresses the whole group, which is the point: it reaches the
 * agent behind an `npx` wrapper. The single-pid fallback covers a child that
 * never got its own group. Windows has neither, so `taskkill /T` walks the tree
 * and `/F` is the only forceful option it offers — SIGTERM has no equivalent,
 * which is why the graceful step there is closing stdio and waiting.
 */
function signalTree(pid: number, signal: NodeJS.Signals): void {
  if (WINDOWS) {
    if (signal !== "SIGKILL") return;
    try {
      execFileSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // Already gone, or never ours.
    }
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone, which is the outcome this function wanted.
    }
  }
}

/**
 * Ask a child's process group to exit, then insist.
 *
 * SIGTERM alone is a request an agent is free to ignore, and some do while
 * finishing a tool call. The escalation timer is unref'd so that waiting to
 * kill something never becomes the reason the daemon itself stays alive.
 *
 * On Windows only the escalation happens: there is no SIGTERM to send, and the
 * real graceful signal on every platform is the caller closing the connection
 * first — an agent that sees EOF on stdin exits long before this fires.
 */
export function terminateChild(
  pid: number,
  hasExited: () => boolean,
  graceMs = TERMINATE_GRACE_MS,
): void {
  signalTree(pid, "SIGTERM");
  const timer = setTimeout(() => {
    if (!hasExited()) signalTree(pid, "SIGKILL");
  }, graceMs);
  timer.unref?.();
}

/**
 * Kill agents left behind by daemons that are no longer running.
 *
 * Called once at startup. Entries owned by a *live* daemon are left strictly
 * alone: two daemons on one machine is a normal state (a launchd service and a
 * foreground `bun run`), and stealing each other's agents would be a far worse
 * bug than the leak this fixes.
 *
 * @returns The pids it killed, for logging and tests.
 */
export async function sweepOrphans(env: NodeJS.ProcessEnv = process.env): Promise<number[]> {
  const records = await readRegistry(env);
  if (records.length === 0) return [];

  const killed: number[] = [];
  const keep: ChildRecord[] = [];

  for (const record of records) {
    // A *different* live daemon owns it, so it is somebody's working agent.
    //
    // Our own pid is deliberately not spared here. This runs once, at module
    // load, before this process has registered anything — so a record claiming
    // us as its owner is a dead daemon's record whose pid the OS has since
    // handed to us. That is exactly the orphan this sweep exists to reap, and
    // the identity check below is what stops it touching a reused pid.
    if (record.ownerPid !== process.pid && alive(record.ownerPid)) {
      keep.push(record);
      continue;
    }
    // Same command line as when it was recorded, or the number has been reused
    // by an unrelated process and must not be touched.
    if ((await identityOf(record.pid)) === record.command) {
      signalTree(record.pid, "SIGKILL");
      killed.push(record.pid);
    }
  }

  await enqueue(env, (current) => {
    const survivors = new Set(keep.map((r) => r.pid));
    // Re-read rather than writing `keep` verbatim: this daemon registers its
    // own children while the sweep is running, and they must not be dropped.
    return current.filter((r) => survivors.has(r.pid) || r.ownerPid === process.pid);
  });

  return killed;
}
