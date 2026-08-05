/**
 * Keeping a running daemon in step with the pairing on disk.
 *
 * `pew2 pair --rotate` mints a new token and writes it to `pairing.json`. The
 * daemon that is already running knows nothing about it, and the relay room id
 * is derived from that token — so the daemon keeps listening in the old room
 * while the freshly paired phone joins the new one. Neither can see the other.
 *
 * What that looked like: pair, phone connects to nothing, re-pair to "fix" it,
 * and the second rotation moves the room again. Every attempt to recover made
 * it worse, and the only cure was restarting the daemon, which nothing on
 * screen suggested.
 *
 * The reload itself is deliberately not clever. Two clients are told the new
 * credentials and existing sockets are dropped: they are sealed with a key that
 * no longer applies, so they cannot be salvaged, and the phone reconnects on
 * its own.
 */
import { watch } from "node:fs";
import type { Pairing } from "./pairing.js";

/** Backoff between retries of a pairing file that will not apply. */
const RELOAD_RETRY_MS = 500;
/** How many times to retry before leaving a broken file alone. */
const MAX_RELOAD_FAILURES = 5;

/** What a reload has to touch to make a rotation take effect. */
export interface PairingTargets {
  /** Swap the LAN listener's expected token and encryption key. */
  onPairing: (pairing: Pairing) => void;
  /** Close sockets sealed with the previous key. */
  disconnectClients: () => void;
  /** Move the relay client into the new room, if there is one. */
  rekeyRelay?: (token: string, key: string) => void;
  log?: (message: string) => void;
}

/**
 * Apply a pairing that has just been read from disk.
 *
 * Pure and separately testable: the file watching around it is untestable
 * timing, but *what a rotation does* is the part that has to be right.
 */
export function applyPairing(
  next: Pairing,
  previous: { token: string; key?: string },
  targets: PairingTargets,
): boolean {
  // A relay change alone still counts: `pew2 relay <url>` rewrites the same
  // file, and the daemon should follow that too.
  if (next.token === previous.token && next.key === previous.key) return false;

  // A pairing file with no key predates encryption or was hand-edited. Refusing
  // to apply it keeps the daemon on the credentials it started with rather than
  // downgrading a running, working connection.
  if (!next.key) {
    targets.log?.("[pairing] ignored a rotation with no encryption key");
    return false;
  }

  targets.onPairing(next);
  targets.rekeyRelay?.(next.token, next.key);
  // After the swap, so the sockets being closed are already the old ones.
  targets.disconnectClients();
  targets.log?.("[pairing] token rotated — reconnect from the app");
  return true;
}

/** The two fields a rotation can change, copied out of a pairing. */
type PairingSnapshot = Pick<Pairing, "token" | "key">;
function snapshot(p: Pairing): PairingSnapshot {
  const out: Record<string, unknown> = {};
  out["token"] = p.token;
  out["key"] = p.key;
  return out as PairingSnapshot;
}

/**
 * The reload trigger, without the file watching.
 *
 * Split out because the coalescing rule is the part that has to be right and
 * `fs.watch` is the part that cannot be driven from a test: the OS decides
 * whether two writes are one event or two, so a test built on real file events
 * passes whether or not the logic underneath it works. This is called by the
 * watcher below and directly by its tests.
 */
export function reloader(
  initial: Pairing,
  read: () => Promise<Pairing>,
  targets: PairingTargets,
  /** Injectable so the retry delay does not make tests slow. */
  delay: (ms: number, run: () => void) => void = (ms, run) => {
    setTimeout(run, ms).unref?.();
  },
): () => void {
  let previous = snapshot(initial);
  let reloading = false;
  let again = false;
  let failures = 0;

  const reload = (): void => {
    // Coalesce, never drop. A save touches the file more than once, so
    // reloading on each event would cost the phone its session repeatedly \u2014
    // but ignoring an event that lands mid-read loses the newest write for
    // good, and the daemon keeps credentials nobody can reach it with. That is
    // the original bug wearing a different hat.
    if (reloading) {
      again = true;
      return;
    }
    reloading = true;

    const finish = (retry: boolean) => {
      reloading = false;
      if (retry) {
        // Backed off and capped. An unconditional immediate re-run spins a core
        // flat out forever on any *persistent* failure \u2014 a pairing file with a
        // 64-character key that is not hex passes `loadPairing` and then throws
        // in `fromHex` on every single pass.
        if (failures >= MAX_RELOAD_FAILURES) {
          targets.log?.("[pairing] could not apply the pairing file; leaving it alone");
          failures = 0;
          again = false;
          return;
        }
        failures += 1;
        delay(RELOAD_RETRY_MS, reload);
        return;
      }
      failures = 0;
      if (again) {
        again = false;
        reload();
      }
    };

    void read()
      .catch(() => {
        // Attached to `read` alone. Chained after `then`, this also swallowed
        // failures from `targets`, which is how a broken pairing turned into an
        // endless loop rather than one logged refusal.
        return undefined;
      })
      .then((next) => {
        if (!next) {
          // A half-written file reads as invalid JSON. Worth retrying: the
          // write that follows may be the last one.
          finish(true);
          return;
        }
        try {
          if (applyPairing(next, previous, targets)) previous = snapshot(next);
        } catch (error) {
          // Logged every time, because a rotation that will not apply is
          // something the person at the keyboard has to see \u2014 the phone is not
          // coming back on its own. Retried under the same cap as a bad read:
          // a target can fail transiently, and a permanent failure gives up
          // after a handful of attempts rather than spinning.
          targets.log?.(`[pairing] rotation failed: ${(error as Error).message}`);
          finish(true);
          return;
        }
        finish(false);
      });
  };
  return reload;
}

/**
 * Watch the pairing file and apply rotations to a running daemon.
 *
 * Returns a stop function. A watcher that cannot be created is swallowed on
 * purpose: a daemon that cannot watch a file must still serve, and the fallback
 * is the old behaviour of needing a restart.
 */
export function watchPairing(
  path: string,
  initial: Pairing,
  read: () => Promise<Pairing>,
  targets: PairingTargets,
): () => void {
  const reload = reloader(initial, read, targets);

  try {
    const watcher = watch(path, { persistent: false }, reload);
    return () => watcher.close();
  } catch {
    return () => {};
  }
}
