/**
 * The ACP handshake's failure modes.
 *
 * `connectProvider` spawns a real process, so most of it is not unit-testable
 * without one. What is tested here is the part that had no bound at all: an
 * agent that never answers `initialize`.
 *
 * That case is not hypothetical. A corrupt `npx` cache, an agent that prompts
 * for login on a stdin nobody is reading, or a package that simply does not
 * speak ACP all produce a process that starts cleanly and then says nothing —
 * and every caller above this (the capability probe, the app's session list)
 * awaits it with no timeout of its own. The visible symptom was a phone stuck
 * on a loading skeleton with nothing in the log.
 */
import { expect, test } from "bun:test";
import { HANDSHAKE_TIMEOUT_MARKER, withTimeout } from "./connect.js";

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
