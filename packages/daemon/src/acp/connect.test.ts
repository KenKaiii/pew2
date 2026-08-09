/**
 * The ACP handshake's failure modes.
 *
 * `connectProvider` spawns a real process, so most of it is not unit-testable
 * without one. What is tested here is the part that had no bound at all: an
 * agent that never answers `initialize` — plus, with one real spawn at the
 * bottom, the process lifecycle: a child gets its own process group, and
 * closing the session takes that whole group with it.
 *
 * That case is not hypothetical. A corrupt `npx` cache, an agent that prompts
 * for login on a stdin nobody is reading, or a package that simply does not
 * speak ACP all produce a process that starts cleanly and then says nothing —
 * and every caller above this (the capability probe, the app's session list)
 * awaits it with no timeout of its own. The visible symptom was a phone stuck
 * on a loading skeleton with nothing in the log.
 */
import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  connectProvider,
  HANDSHAKE_TIMEOUT_MARKER,
  restoreMethodFor,
  withTimeout,
} from "./connect.js";
import type { LoadedProvider } from "../providers/registry.js";

test("a promise that never settles is rejected with the caller's error", async () => {
  const never = new Promise<string>(() => {});
  let built = 0;

  await expect(
    withTimeout(never, 10, () => {
      built++;
      return new Error("did not respond to the ACP handshake");
    }),
  ).rejects.toThrow("did not respond to the ACP handshake");

  // Built once, when it fired — not eagerly on every call.
  expect(built).toBe(1);
});

test("the message is built at the moment of failure, not when the wait began", async () => {
  // Why it is a callback: the useful detail is what the agent printed to stderr
  // before giving up, and at the start of the wait that is always empty.
  const stderr: string[] = [];
  const pending = new Promise<void>(() => {});

  const settled = withTimeout(pending, 30, () => new Error(`stderr: ${stderr.join(",")}`));
  stderr.push("npm error ENOENT");

  await expect(settled).rejects.toThrow("stderr: npm error ENOENT");
});

test("a fast agent is unaffected, and the timer does not hold the loop open", async () => {
  // The timeout is a backstop for the wedged case, never a budget a healthy
  // agent has to beat.
  await expect(withTimeout(Promise.resolve("ok"), 60_000, () => new Error("nope"))).resolves.toBe(
    "ok",
  );

  // An uncleared 60s timer would keep the process alive well past this test; the
  // suite finishing promptly is the observable part of clearing it.
  const start = Date.now();
  await withTimeout(Promise.resolve(1), 60_000, () => new Error("nope"));
  expect(Date.now() - start).toBeLessThan(1_000);
});

test("a real rejection passes through unchanged rather than becoming a timeout", async () => {
  // ENOENT for a missing binary already has an actionable message. Replacing it
  // with "did not respond" would send the user looking for the wrong problem.
  await expect(
    withTimeout(Promise.reject(new Error("'goose' was not found on PATH")), 60_000, () =>
      new Error("did not respond"),
    ),
  ).rejects.toThrow("was not found on PATH");
});

test("the timeout marker survives being carried through a rejection", async () => {
  // `connectProvider` tells its two failures apart by looking for this marker:
  // a timeout is re-thrown as-is, anything else is wrapped as "failed to start".
  // The two give opposite advice — "it is stuck" versus "it died, here is what it
  // said" — so the marker has to survive the trip intact.
  const timedOut: Error = await withTimeout(
    new Promise<never>(() => {}),
    10,
    () => new Error(`'Cline' ${HANDSHAKE_TIMEOUT_MARKER}. It was started with: npx cline`),
  ).catch((error: Error) => error);

  expect(timedOut.message).toContain(HANDSHAKE_TIMEOUT_MARKER);

  // The marker must not be so generic that an ordinary agent crash matches it,
  // which would report a dead process as merely slow.
  expect("ACP connection closed").not.toContain(HANDSHAKE_TIMEOUT_MARKER);
  expect("'goose' was not found on PATH").not.toContain(HANDSHAKE_TIMEOUT_MARKER);
});

test("a conversation already on screen is restored without a second copy of it", () => {
  // The daemon paints every thread from its own cache before the agent attaches,
  // then discards whatever the agent replays on top. Against GG Coder that was
  // 8,457 update notifications decoded and dropped, and 941ms instead of 418ms —
  // more than half the cost of reopening a conversation, which is exactly the
  // cost the idle-session reaper trades against.
  expect(restoreMethodFor(true, true)).toBe("session/resume");
});

test("an agent that never offered resume is still asked to replay", () => {
  // Asking for a capability an agent did not advertise is a protocol error, not
  // a graceful no-op: it fails the whole open rather than falling back. Claude
  // Code is in this group today.
  expect(restoreMethodFor(true, false)).toBe("session/load");
});

test("without the transcript, the replay is the only way to draw the thread", () => {
  // The other half of the condition. A conversation with no cached history has
  // nothing on screen, so skipping the replay would open an empty thread that
  // never fills — worse than the 500ms it saves.
  expect(restoreMethodFor(false, true)).toBe("session/load");
  expect(restoreMethodFor(false, false)).toBe("session/load");
});

/** The echo agent: a real ACP peer that needs no key, no network and no PATH. */
const echoProvider: LoadedProvider = {
  manifest: { id: "echo", name: "echo" } as LoadedProvider["manifest"],
  source: "<test>",
  command: "bun",
  args: ["run", new URL("../testing/echo-agent.ts", import.meta.url).pathname],
  missingEnv: [],
  commandMissing: false,
};

// Process groups and `ps` are POSIX; the Windows path kills with `taskkill /T`
// and cannot be asserted the same way.
const posixTest = process.platform === "win32" ? test.skip : test;

posixTest("a spawned agent is its own process group, and close() ends the group", async () => {
  // Both halves of the same bug. Five bundled providers launch through `npx`,
  // so the process spawned here is a launcher and the agent is its child:
  // signalling only the launcher reparented the real agent to pid 1, where it
  // ran until the machine rebooted. `detached` is the only thing that creates
  // the group, and without the group there is nothing for `close()` to address.
  //
  // Redirected because connecting records the child in the daemon's own state
  // directory, and a test must not write to the one a live daemon is reading.
  const previousHome = process.env.PEW2_HOME;
  process.env.PEW2_HOME = mkdtempSync(join(tmpdir(), "pew2-connect-"));

  try {
    const handle = await connectProvider({
      provider: echoProvider,
      cwd: tmpdir(),
      onUpdate: () => {},
      onPermissionRequest: () => {},
    });

    const pid = handle.child.pid!;
    const exited = new Promise<void>((resolve) => handle.child.once("exit", () => resolve()));

    // Its own group leader: the group id equals the pid, so `kill(-pid)` reaches
    // this agent and its descendants and nothing else on the machine.
    const group = Number(
      execFileSync("ps", ["-o", "pgid=", "-p", String(pid)]).toString().trim(),
    );
    expect(group).toBe(pid);

    handle.close();
    await exited;
  } finally {
    if (previousHome === undefined) delete process.env.PEW2_HOME;
    else process.env.PEW2_HOME = previousHome;
  }
});
