/**
 * Log rotation runs on every daemon start, which makes its failure modes
 * expensive: a bug here either loses the lines someone needs to debug an
 * outage, or stops the daemon starting at all.
 */
import { expect, test } from "bun:test";
import { mkdtemp, open, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonLogPaths, rotateLog, startLogRotation } from "./logs.js";

async function tempLog(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pew2-logs-"));
  const path = join(dir, "daemon.log");
  await writeFile(path, contents);
  return path;
}

test("a log under the cap is left exactly as it was", async () => {
  const path = await tempLog("one\ntwo\nthree\n");
  const result = await rotateLog(path, 1024, 512);

  expect(result.rotated).toBe(false);
  expect(await readFile(path, "utf8")).toBe("one\ntwo\nthree\n");
});

test("an oversized log keeps its tail, because that is the part worth reading", async () => {
  // The last lines are the ones written just before whatever went wrong.
  const lines = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join("\n") + "\n";
  const path = await tempLog(lines);

  const result = await rotateLog(path, 1024, 512);
  const after = await readFile(path, "utf8");

  expect(result.rotated).toBe(true);
  expect(result.before).toBeGreaterThan(1024);
  expect((await stat(path)).size).toBeLessThanOrEqual(512);

  // The most recent line survived; an early one did not.
  expect(after).toContain("line 1999");
  expect(after).not.toContain("line 0\n");
});

test("rotation never leaves a half-written first line", async () => {
  // Cutting at a byte offset lands mid-line; a log that opens on fragment of a
  // stack trace reads as corruption.
  const lines = Array.from({ length: 500 }, (_, i) => `entry-${i}-padding-padding`).join("\n") + "\n";
  const path = await tempLog(lines);

  await rotateLog(path, 512, 256);
  const after = await readFile(path, "utf8");

  expect(after.length).toBeGreaterThan(0);
  expect(after.split("\n")[0]).toMatch(/^entry-\d+-padding-padding$/);
});

test("a writer already holding the file keeps appending correctly", async () => {
  // The reason this truncates in place instead of renaming. launchd opens the
  // log once, in append mode, and holds that descriptor for the life of the
  // daemon. Renaming would leave it writing to `daemon.log.1` while
  // `daemon.log` stayed empty; truncating without append semantics would leave
  // the file padded with NUL bytes out to the old offset.
  const path = await tempLog("old\n".repeat(2000));
  const writer = await open(path, "a");

  try {
    const result = await rotateLog(path, 1024, 512);
    expect(result.rotated).toBe(true);

    await writer.write("after-rotation\n");
    const after = await readFile(path, "utf8");

    // Landed at the end of the trimmed file, not at the pre-rotation offset.
    expect(after.endsWith("after-rotation\n")).toBe(true);
    expect(after).not.toContain("\0");
    expect((await stat(path)).size).toBeLessThan(1024);
  } finally {
    await writer.close();
  }
});

test("a missing log is not an error", async () => {
  // First run on a new machine, and the only case that happens every install.
  const result = await rotateLog(join(tmpdir(), "pew2-nonexistent", "daemon.log"));
  expect(result).toEqual({ rotated: false, before: 0, after: 0 });
});

test("an unreadable log never stops the daemon starting", async () => {
  // Housekeeping must not become an outage: a directory where a file is
  // expected fails every read, and rotation still has to return.
  const dir = await mkdtemp(join(tmpdir(), "pew2-logs-"));
  const result = await rotateLog(dir, 0, 10);
  expect(result.rotated).toBe(false);
});

test("a daemon that never restarts still gets its log trimmed", async () => {
  // The case the startup pass cannot cover: a launchd service running for weeks
  // crosses the ceiling long after its one and only rotation.
  const path = await tempLog("x".repeat(4096) + "\n");
  const rotated: string[] = [];
  const stop = startLogRotation({
    paths: [path],
    intervalMs: 5,
    max: 1024,
    keep: 256,
    onRotate: (p) => rotated.push(p),
  });
  try {
    await Bun.sleep(60);
  } finally {
    stop();
  }

  expect(rotated).toContain(path);
  expect((await stat(path)).size).toBeLessThan(4096);

  // Stopping means stopping: a cleared timer must not trim again afterwards.
  await writeFile(path, "y".repeat(4096) + "\n");
  await Bun.sleep(30);
  expect((await stat(path)).size).toBe(4097);
});

test("periodic rotation survives a log it cannot read", async () => {
  // Same rule as the startup pass, but the stakes are higher: a throw inside an
  // interval callback is an unhandled rejection, which kills a running daemon
  // and every session on it.
  const dir = await mkdtemp(join(tmpdir(), "pew2-logs-"));
  const stop = startLogRotation({ paths: [dir], intervalMs: 5, max: 0, keep: 10 });
  try {
    await Bun.sleep(40);
  } finally {
    stop();
  }
});

test("a reporting callback that throws does not take the daemon with it", async () => {
  // `onRotate` is the caller's code, and the caller is the daemon that holds
  // every live session. An unhandled rejection out of housekeeping must not be
  // how they all end.
  const path = await tempLog("x".repeat(4096) + "\n");
  let calls = 0;
  const stop = startLogRotation({
    paths: [path],
    intervalMs: 5,
    max: 1024,
    keep: 256,
    onRotate: () => {
      calls += 1;
      throw new Error("reporting blew up");
    },
  });
  try {
    await Bun.sleep(40);
  } finally {
    stop();
  }

  // The throw has to have actually happened, or this proves nothing.
  expect(calls).toBeGreaterThan(0);
  // And the work still landed: the rotation runs before the report.
  expect((await stat(path)).size).toBeLessThan(4096);
});

test("both streams are rotated, and PEW2_HOME is honoured", () => {
  // stderr is the one that runs away: a provider failing every probe writes a
  // stack trace each time, unwatched.
  // Both files, in order, under whatever home was given - asserted with `join`
  // so it is the same claim on either platform.
  expect(daemonLogPaths({ PEW2_HOME: join("/tmp", "x") } as NodeJS.ProcessEnv)).toEqual([
    join("/tmp", "x", "logs", "daemon.log"),
    join("/tmp", "x", "logs", "daemon.error.log"),
  ]);
  expect(daemonLogPaths({} as NodeJS.ProcessEnv, join("/Users", "someone"))[0]).toBe(
    join("/Users", "someone", ".pew2", "logs", "daemon.log"),
  );
});
