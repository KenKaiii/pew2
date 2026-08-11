/**
 * Update-scheduler tests.
 *
 * The property that matters is not "does it update" — it is "does it ever end
 * the process at a moment that costs the user something". A daemon that exits
 * mid-turn loses work that cannot be resumed from the middle, and one that
 * exits with a permission on screen makes the user's next tap do nothing. So
 * every test below asserts on `exits`, and the busy ones assert it stayed empty.
 *
 * Nothing here touches the network, the filesystem, or a real timer: `check`,
 * `apply`, `busyReason` and `exit` are all injected.
 */
import { test, expect } from "bun:test";
import { startUpdateScheduler, type UpdateStatus } from "./scheduler.js";
import type { ApplyResult } from "./apply.js";

const NEWER = { current: "0.9.17", latest: "0.9.18", newer: true };
const SAME = { current: "0.9.17", latest: "0.9.17", newer: false };

const APPLIED: ApplyResult = {
  ok: true,
  previous: "0.9.17",
  installed: "0.9.18",
  path: "/usr/local/bin/pew2",
  restartRequired: true,
};

/**
 * A scheduler with every dependency stubbed.
 *
 * `firstDelayMs` is enormous so the armed timer never fires on its own: each
 * test drives `tick()` by hand, which is what keeps these deterministic.
 */
function harness(
  options: {
    check?: () => Promise<typeof NEWER | null>;
    apply?: () => Promise<ApplyResult>;
    busy?: () => string | undefined;
    eligible?: boolean;
    installed?: boolean;
  } = {},
) {
  const exits: number[] = [];
  const logs: string[] = [];
  const shutdowns: number[] = [];
  // Every status the scheduler published, in order — this is what reaches the
  // phone, so the sequence matters as much as the final value.
  const statuses: (UpdateStatus | undefined)[] = [];
  let applyCalls = 0;

  const scheduler = startUpdateScheduler({
    check: (options.check ?? (async () => NEWER)) as never,
    apply: (async () => {
      applyCalls++;
      return options.apply ? await options.apply() : APPLIED;
    }) as never,
    eligible: () => options.eligible ?? true,
    // A released binary unless a test says otherwise; `isCompiled()` is false
    // under `bun test`, which would otherwise disarm every case here.
    installed: () => options.installed ?? true,
    onStatus: (status) => statuses.push(status),
    busyReason: options.busy ?? (() => undefined),
    exit: (code) => exits.push(code),
    shutdown: () => shutdowns.push(Date.now()),
    log: (message) => logs.push(message),
    firstDelayMs: 60 * 60 * 1000,
    intervalMs: 60 * 60 * 1000,
  });

  return {
    scheduler,
    exits,
    logs,
    shutdowns,
    statuses,
    applyCalls: () => applyCalls,
  };
}

test("an idle daemon exits after a successful apply", async () => {
  const h = harness();

  await h.scheduler!.tick();

  expect(h.exits).toEqual([0]);
  // Agents are released before the process ends, exactly as on a signal.
  expect(h.shutdowns).toHaveLength(1);
  expect(h.logs.join("\n")).toContain("restarting on 0.9.18");
  h.scheduler!.stop();
});

test("a daemon mid-turn does not exit", async () => {
  const h = harness({ busy: () => "session s1 is mid-turn" });

  await h.scheduler!.tick();

  // The binary was swapped — that part is safe at any time — but the process
  // that would abandon the turn is still running.
  expect(h.exits).toEqual([]);
  expect(h.shutdowns).toEqual([]);
  expect(h.scheduler!.pending()).toBe(true);
  expect(h.logs.join("\n")).toContain("holding until idle: session s1 is mid-turn");
  h.scheduler!.stop();
});

test("a daemon waiting on an approval does not exit", async () => {
  // Killing this one turns a question already on someone's screen into a tap
  // that does nothing.
  const h = harness({ busy: () => "session s1 is waiting on an approval" });

  await h.scheduler!.tick();

  expect(h.exits).toEqual([]);
  h.scheduler!.stop();
});

test("a daemon that goes quiet later exits on the next tick, without re-downloading", async () => {
  let busy: string | undefined = "session s1 is mid-turn";
  const h = harness({ busy: () => busy });

  await h.scheduler!.tick();
  expect(h.exits).toEqual([]);

  busy = undefined;
  await h.scheduler!.tick();

  expect(h.exits).toEqual([0]);
  // The binary was already on disk; a second apply would be a wasted 60MB.
  expect(h.applyCalls()).toBe(1);
  h.scheduler!.stop();
});

test("no newer release means no apply and no exit", async () => {
  const h = harness({ check: async () => SAME });

  await h.scheduler!.tick();

  expect(h.applyCalls()).toBe(0);
  expect(h.exits).toEqual([]);
  h.scheduler!.stop();
});

test("a failed check never exits", async () => {
  // `null` is "could not tell" — offline, rate-limited, a broken tag. It is
  // never a reason to act.
  const h = harness({ check: async () => null });

  await h.scheduler!.tick();

  expect(h.applyCalls()).toBe(0);
  expect(h.exits).toEqual([]);
  expect(h.scheduler!.pending()).toBe(false);
  h.scheduler!.stop();
});

test("a check that throws never exits, and never escapes as a rejection", async () => {
  // This runs on a timer inside a daemon holding someone's session; an
  // unhandled rejection here is worse than a missed update.
  const h = harness({
    check: async () => {
      throw new Error("DNS is down");
    },
  });

  await h.scheduler!.tick();

  expect(h.exits).toEqual([]);
  expect(h.logs.join("\n")).toContain("check failed: DNS is down");
  h.scheduler!.stop();
});

test("a failed apply never exits", async () => {
  const h = harness({
    apply: async () => ({
      ok: false,
      reason: "download-failed",
      detail: "Could not download pew2-darwin-arm64.",
    }),
  });

  await h.scheduler!.tick();

  expect(h.exits).toEqual([]);
  expect(h.scheduler!.pending()).toBe(false);
  expect(h.logs.join("\n")).toContain("not applied: download-failed");
  h.scheduler!.stop();
});

test("a checksum mismatch never exits, and is not fatal to later attempts", async () => {
  // The running binary is untouched and still correct, so a bad transfer must
  // not stop tomorrow's check.
  let fail = true;
  const h = harness({
    apply: async () =>
      fail
        ? { ok: false, reason: "checksum-mismatch", detail: "bytes do not match" }
        : APPLIED,
  });

  await h.scheduler!.tick();
  expect(h.exits).toEqual([]);

  fail = false;
  await h.scheduler!.tick();

  expect(h.exits).toEqual([0]);
  h.scheduler!.stop();
});

test("a source checkout arms nothing at all", () => {
  // Where the answer is `git pull`, not an install script. Also keeps every
  // `npm test` run and every dev daemon off GitHub.
  const h = harness({ installed: false });

  expect(h.scheduler).toBeUndefined();
});

test("stop prevents any further exit", async () => {
  const h = harness();

  h.scheduler!.stop();
  await h.scheduler!.tick();

  expect(h.exits).toEqual([]);
});

test("overlapping ticks do not download twice", async () => {
  // A 60MB download over a slow link can outlast the interval.
  let release: (() => void) | undefined;
  const h = harness({
    check: async () => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return NEWER;
    },
  });

  const first = h.scheduler!.tick();
  const second = h.scheduler!.tick();
  release!();
  await Promise.all([first, second]);

  expect(h.applyCalls()).toBe(1);
  expect(h.exits).toEqual([0]);
  h.scheduler!.stop();
});

test("the exit still happens when releasing agents throws", async () => {
  // The binary on disk has already been replaced; refusing to restart would
  // leave the machine running an executable that no longer exists.
  const exits: number[] = [];
  const scheduler = startUpdateScheduler({
    check: (async () => NEWER) as never,
    apply: (async () => APPLIED) as never,
    eligible: () => true,
    installed: () => true,
    busyReason: () => undefined,
    exit: (code) => exits.push(code),
    shutdown: () => {
      throw new Error("relay already gone");
    },
    log: () => {},
    firstDelayMs: 60 * 60 * 1000,
    intervalMs: 60 * 60 * 1000,
  });

  await scheduler!.tick();

  expect(exits).toEqual([0]);
  scheduler!.stop();
});

test("the first check is delayed, not run on boot", async () => {
  // A daemon that has just started is answering a phone trying to reconnect.
  let checked = 0;
  const scheduler = startUpdateScheduler({
    check: (async () => {
      checked++;
      return SAME;
    }) as never,
    eligible: () => true,
    installed: () => true,
    busyReason: () => undefined,
    exit: () => {},
    log: () => {},
    firstDelayMs: 60 * 60 * 1000,
    intervalMs: 60 * 60 * 1000,
  });

  await new Promise((resolve) => setTimeout(resolve, 20));

  expect(checked).toBe(0);
  scheduler!.stop();
});

test("the timer never holds the process open", async () => {
  // `unref` matters: a daemon whose work is done must be free to exit, and an
  // update check is the definition of optional work.
  let armed: NodeJS.Timeout | undefined;
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = ((fn: () => void, ms: number) => {
    const timer = realSetTimeout(fn, ms);
    armed ??= timer;
    return timer;
  }) as typeof setTimeout;

  try {
    const scheduler = startUpdateScheduler({
      check: (async () => SAME) as never,
      eligible: () => true,
      installed: () => true,
      busyReason: () => undefined,
      exit: () => {},
      log: () => {},
      firstDelayMs: 60 * 60 * 1000,
      intervalMs: 60 * 60 * 1000,
    });
    expect(armed?.hasRef()).toBe(false);
    scheduler!.stop();
  } finally {
    globalThis.setTimeout = realSetTimeout;
  }
});

// --- what the phone is told ------------------------------------------------
//
// The daemon has no screen. These decide what a person ever learns about a
// machine that is behind, so the wrong answer here is silence about the one
// case that needs a human.

test("a machine that cannot update itself says so, and does not try", () => {
  // The case the notice exists for: no service registered, so an exit is not a
  // restart. It used to arm nothing at all — the one situation needing a human
  // was the one situation nothing was watching.
  const h = harness({ eligible: false });

  return h.scheduler!.tick().then(() => {
    expect(h.statuses).toEqual([{ latest: "0.9.18", automatic: false }]);
    expect(h.applyCalls()).toBe(0);
    expect(h.exits).toEqual([]);
    h.scheduler!.stop();
  });
});

test("a machine that will update itself says so too, but as news not a task", async () => {
  // Reported before the attempt so a slow download is not silence, and marked
  // automatic so the app words it as reassurance rather than an instruction.
  const h = harness({ busy: () => "session s1 is mid-turn" });

  await h.scheduler!.tick();

  expect(h.statuses[0]).toEqual({ latest: "0.9.18", automatic: true });
  h.scheduler!.stop();
});

test("an installed update stops being announced", async () => {
  // It is on disk and certain to be running after the next quiet moment, so the
  // notice has done its job. Leaving it up would outlive the thing it describes.
  const h = harness({ busy: () => "session s1 is mid-turn" });

  await h.scheduler!.tick();

  expect(h.statuses).toEqual([{ latest: "0.9.18", automatic: true }, undefined]);
  h.scheduler!.stop();
});

test("an update that keeps failing stops promising it is automatic", async () => {
  // The self-correcting half. Whatever the reason — an unwritable prefix, a
  // proxy eating the download — the phone ends up telling the user to do it by
  // hand rather than waiting forever on a daemon that cannot.
  const h = harness({
    apply: async () => ({ ok: false, reason: "not-writable", detail: "/usr/local/bin" }),
  });

  await h.scheduler!.tick();

  expect(h.statuses).toEqual([
    { latest: "0.9.18", automatic: true },
    { latest: "0.9.18", automatic: false },
  ]);
  h.scheduler!.stop();
});

test("being up to date clears a notice left by a manual install", async () => {
  // Someone read the notice and ran the install line. Continuing to tell them
  // to do what they just did is the one way this feature becomes furniture.
  let latest = NEWER;
  const h = harness({ eligible: false, check: async () => latest });

  await h.scheduler!.tick();
  expect(h.statuses).toEqual([{ latest: "0.9.18", automatic: false }]);

  latest = SAME;
  await h.scheduler!.tick();

  expect(h.statuses).toEqual([{ latest: "0.9.18", automatic: false }, undefined]);
  h.scheduler!.stop();
});

test("an unchanged status is not republished", async () => {
  // Every change re-announces to every connected client. Repeating the same
  // string on each six-hourly tick would be a broadcast for nothing.
  const h = harness({ eligible: false });

  await h.scheduler!.tick();
  await h.scheduler!.tick();
  await h.scheduler!.tick();

  expect(h.statuses).toHaveLength(1);
  h.scheduler!.stop();
});

test("a failed check leaves an existing notice standing", async () => {
  // Offline is not evidence of being up to date. Clearing here would make the
  // notice flicker every time the machine lost its connection.
  let answer: typeof NEWER | null = NEWER;
  const h = harness({ eligible: false, check: async () => answer });

  await h.scheduler!.tick();
  answer = null;
  await h.scheduler!.tick();

  expect(h.statuses).toEqual([{ latest: "0.9.18", automatic: false }]);
  h.scheduler!.stop();
});

test("status() answers what was last published", async () => {
  const h = harness({ eligible: false });
  expect(h.scheduler!.status()).toBeUndefined();

  await h.scheduler!.tick();

  expect(h.scheduler!.status()).toEqual({ latest: "0.9.18", automatic: false });
  h.scheduler!.stop();
});
