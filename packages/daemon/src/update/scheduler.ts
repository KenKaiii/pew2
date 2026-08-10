/**
 * Keep this machine's daemon on the current release, without anyone noticing.
 *
 * Step three, and the piece that makes the other two matter: check on a timer,
 * swap the binary when there is something newer, then end the process at a
 * moment when ending it costs nothing. launchd starts it again on the new
 * inode — `KeepAlive: true` in the plist `cli/service.ts` installs — so the
 * user's phone reconnects to a daemon that has quietly become the new version.
 *
 * ## Exiting is the update, and timing it is the whole problem
 *
 * Replacing the file changes nothing on its own: the running process keeps
 * executing the old inode until it ends (`e7717f9`). So the swap is the easy
 * half and the exit is the dangerous one. A daemon that exits during a turn
 * loses work that cannot be resumed from the middle, and a daemon that exits
 * while a permission is on screen turns the user's next tap into nothing at
 * all.
 *
 * Hence: the binary is swapped as soon as one is available, and the exit waits
 * — indefinitely if need be — for `busyReason()` to come back undefined. A busy
 * daemon simply tries again on the next tick, which is why the tick keeps
 * running after a successful apply. The update is already on disk at that
 * point; all that is pending is a moment to use it.
 *
 * ## What it will not do
 *
 * Both gates from `apply.ts` still hold — macOS only, compiled builds only —
 * and are checked *before* the first timer is armed, so on Linux, Windows, or a
 * source checkout this module arms nothing and costs nothing. A machine that
 * cannot restart itself must not be left with a swapped binary and an old
 * process; see the header of `apply.ts` for why no other platform qualifies.
 */
import { applyUpdate, canSelfUpdate, type ApplyResult } from "./apply.js";
import { checkForUpdate } from "./check.js";

/**
 * How long after boot the first check runs.
 *
 * Not immediately: a daemon has just been started, possibly by launchd at
 * login, and the first seconds are for answering the phone that is trying to
 * reconnect. Long enough to be out of the way, short enough that a machine
 * woken once a day still checks.
 */
export const FIRST_CHECK_DELAY_MS = 5 * 60 * 1000;

/** How often to look after that. Four times a day is plenty for a daemon. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface SchedulerDeps {
  /** Injected in tests; defaults to the real GitHub check. */
  check?: typeof checkForUpdate;
  /** Injected in tests; defaults to the real download-and-swap. */
  apply?: typeof applyUpdate;
  /** Whether this build could update itself at all. */
  eligible?: () => boolean;
  /** Why the daemon must not be ended right now, if anything. */
  busyReason: () => string | undefined;
  /** How the process ends. Injected so a test never takes the runner down. */
  exit?: (code: number) => void;
  /** Release agents and flush state before the exit. */
  shutdown?: () => void;
  log?: (message: string) => void;
  firstDelayMs?: number;
  intervalMs?: number;
}

export interface UpdateScheduler {
  /** Run one check-apply-maybe-exit cycle now. Exposed for tests and `pew2`. */
  tick(): Promise<void>;
  /** Stop checking. The swapped binary, if any, stays on disk. */
  stop(): void;
  /** Whether a new binary is already in place, waiting for a quiet moment. */
  pending(): boolean;
}

/**
 * Arm the update loop.
 *
 * Returns undefined when this build cannot self-update, so the caller can tell
 * "not scheduled" from "scheduled and idle" without inspecting a platform.
 */
export function startUpdateScheduler(deps: SchedulerDeps): UpdateScheduler | undefined {
  const {
    check = checkForUpdate,
    apply = applyUpdate,
    eligible = canSelfUpdate,
    busyReason,
    exit = (code: number) => process.exit(code),
    shutdown,
    log = console.log,
    firstDelayMs = FIRST_CHECK_DELAY_MS,
    intervalMs = CHECK_INTERVAL_MS,
  } = deps;

  // Checked before a single timer exists: on a platform with no supervisor this
  // module must be completely inert, not merely harmless.
  if (!eligible()) return undefined;

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  /** Set once a new binary is on disk; from then on we are only awaiting quiet. */
  let staged: { version: string } | undefined;
  /** Guards against a slow download overlapping the next tick. */
  let running = false;

  const arm = (delay: number) => {
    if (stopped) return;
    // `void run()` rather than passing `run` itself: a timer callback discards
    // the promise, so a rejection would surface as an unhandled rejection in a
    // daemon holding someone's session. `run` catches everything internally,
    // and this makes that contract explicit rather than incidental.
    timer = setTimeout(() => void run(), delay);
    // Never the reason the process stays alive. A daemon whose work is done
    // must be free to exit, and an update check is the definition of optional.
    timer.unref?.();
  };

  /** End the process so launchd can start the new binary. */
  const exitForUpdate = (version: string) => {
    log(`[update] restarting on ${version}`);
    // The same courtesy the signal path gives: ask agents to stop, then go.
    // `children.ts`'s exit hook is the backstop for anything still up.
    try {
      shutdown?.();
    } catch {
      // A failure to shut down cleanly is not a reason to keep running an
      // executable that has already been replaced on disk.
    }
    exit(0);
  };

  const run = async () => {
    if (stopped || running) return;
    running = true;
    try {
      // Already swapped on an earlier tick and waiting for a gap: there is
      // nothing left to download, only a moment to use.
      if (staged) {
        const busy = busyReason();
        if (busy) {
          log(`[update] ${staged.version} ready, holding: ${busy}`);
          return;
        }
        exitForUpdate(staged.version);
        return;
      }

      const found = await check();
      // `null` is "could not tell" — offline, rate-limited, a broken tag. Never
      // a reason to act, and never a reason to stop checking tomorrow.
      if (!found || !found.newer) return;

      log(`[update] ${found.latest} available (running ${found.current})`);
      const result: ApplyResult = await apply({ version: found.latest });
      if (!result.ok) {
        // Including a checksum mismatch, which is deliberately not fatal here:
        // the current binary is untouched and still correct, and a transient
        // bad transfer must not stop the next attempt.
        log(`[update] not applied: ${result.reason} — ${result.detail}`);
        return;
      }

      log(`[update] ${found.latest} installed, replacing ${result.previous}`);
      staged = { version: found.latest };

      // Swapped and quiet in the same breath is the common case on a machine
      // nobody is using, which is exactly when this should happen.
      const busy = busyReason();
      if (busy) {
        log(`[update] holding until idle: ${busy}`);
        return;
      }
      exitForUpdate(found.latest);
    } catch (error) {
      // A background timer inside a daemon holding someone's session: an
      // unhandled rejection here would be a far worse bug than a missed update.
      log(`[update] check failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      running = false;
      // Re-armed even after a successful apply, because the exit may still be
      // waiting on a busy daemon.
      arm(intervalMs);
    }
  };

  arm(firstDelayMs);

  return {
    tick: run,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    pending: () => staged !== undefined,
  };
}
