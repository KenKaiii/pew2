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
import { isCompiled } from "../cli/service.js";
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
  /** Whether this build could install an update itself. */
  eligible?: () => boolean;
  /**
   * Whether this is a released binary rather than a source checkout.
   *
   * Gates *looking*, where `eligible` gates *acting*.
   */
  installed?: () => boolean;
  /**
   * Called whenever the answer to "is this machine behind?" changes.
   *
   * `undefined` means up to date, or as far as anyone can tell. Only fired on a
   * change, because it triggers a re-announce to every connected client.
   */
  onStatus?: (status: UpdateStatus | undefined) => void;
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

export interface UpdateStatus {
  /** The published version this machine has not got. */
  latest: string;
  /** Whether it will be installed without a human doing anything. */
  automatic: boolean;
}

export interface UpdateScheduler {
  /** What to tell the phone, or undefined when there is nothing to say. */
  status(): UpdateStatus | undefined;
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
 * Two gates, not one, and the difference is the point:
 *
 * - **`installed`** decides whether to *look*. False for a source checkout,
 *   where the answer is `git pull` and a notice about an install script would
 *   be wrong. Also keeps `npm test` and every dev run off GitHub.
 * - **`eligible`** decides whether to *act*. False without a registered
 *   service, where swapping the binary would strand the machine on an exit
 *   nothing comes back from.
 *
 * Checking without acting is the whole reason the phone can say anything: a
 * daemon that cannot install its own update is exactly the one whose user has
 * to be told to re-run the install line. It used to return early here and go
 * completely inert, which meant the only case a human needed to hear about was
 * the one case nothing was watching.
 *
 * Returns undefined only when there is nothing to look for either.
 */
export function startUpdateScheduler(deps: SchedulerDeps): UpdateScheduler | undefined {
  const {
    check = checkForUpdate,
    apply = applyUpdate,
    eligible = canSelfUpdate,
    installed = isCompiled,
    busyReason,
    exit = (code: number) => process.exit(code),
    shutdown,
    onStatus,
    log = console.log,
    firstDelayMs = FIRST_CHECK_DELAY_MS,
    intervalMs = CHECK_INTERVAL_MS,
  } = deps;

  if (!installed()) return undefined;

  /** Whether this build may install what it finds, not merely report it. */
  const mayApply = eligible();

  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  /** Set once a new binary is on disk; from then on we are only awaiting quiet. */
  let staged: { version: string } | undefined;
  /** Guards against a slow download overlapping the next tick. */
  let running = false;
  /** The last thing said to the clients, so a change can be detected. */
  let status: UpdateStatus | undefined;

  /**
   * Publish "this machine is behind", but only when that is news.
   *
   * Every change re-announces to every connected client, so repeating an
   * unchanged status on each six-hourly tick would be a broadcast storm for a
   * string nobody read differently.
   */
  const setStatus = (next: UpdateStatus | undefined) => {
    if (next?.latest === status?.latest && next?.automatic === status?.automatic) return;
    status = next;
    onStatus?.(next);
  };

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
      // a reason to act, and never a reason to stop checking tomorrow. It is
      // also not evidence of being up to date, so a previous notice stands.
      if (!found) return;
      if (!found.newer) {
        // Genuinely current. Clears a notice left by an update that has since
        // been installed by hand — re-running the install line is the documented
        // fix, and it would be absurd to keep telling someone to do what they
        // just did.
        setStatus(undefined);
        return;
      }

      // Said before the attempt, and left standing if the attempt fails: an
      // update that cannot install itself is precisely the one a human has to
      // hear about. `automatic` is what turns it from a status into a task.
      setStatus({ latest: found.latest, automatic: mayApply });

      log(`[update] ${found.latest} available (running ${found.current})`);
      if (!mayApply) {
        // No registered service, so an exit is not a restart. Looking was still
        // worth it: the phone can now say so, which is the only way this
        // machine gets updated at all.
        log(`[update] not installing it: no supervisor to restart this daemon`);
        return;
      }

      const result: ApplyResult = await apply({ version: found.latest });
      if (!result.ok) {
        // Including a checksum mismatch, which is deliberately not fatal here:
        // the current binary is untouched and still correct, and a transient
        // bad transfer must not stop the next attempt.
        log(`[update] not applied: ${result.reason} — ${result.detail}`);
        // It keeps failing, so stop promising it will happen by itself. This is
        // the self-correcting half: whatever the reason — an unwritable prefix,
        // a proxy eating the download — the phone ends up telling the user to
        // do it manually rather than waiting for ever on a daemon that cannot.
        setStatus({ latest: found.latest, automatic: false });
        return;
      }

      log(`[update] ${found.latest} installed, replacing ${result.previous}`);
      staged = { version: found.latest };
      // On disk and certain to be running after the next quiet moment, so the
      // notice has done its job.
      setStatus(undefined);

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
    status: () => status,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    pending: () => staged !== undefined,
  };
}
