/**
 * Log rotation runs on every daemon start, which makes its failure modes
 * expensive: a bug here either loses the lines someone needs to debug an
 * outage, or stops the daemon starting at all.
 */
import { expect, test } from "bun:test";
import { mkdtemp, open, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { daemonLogPaths, rotateLog } from "./logs.js";

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

test("both streams are rotated, and PEW2_HOME is honoured", () => {
  // stderr is the one that runs away: a provider failing every probe writes a
  // stack trace each time, unwatched.
  expect(daemonLogPaths({ PEW2_HOME: "/tmp/x" } as NodeJS.ProcessEnv)).toEqual([
    "/tmp/x/logs/daemon.log",
    "/tmp/x/logs/daemon.error.log",
  ]);
  expect(daemonLogPaths({} as NodeJS.ProcessEnv, "/Users/someone")[0]).toBe(
    "/Users/someone/.pew2/logs/daemon.log",
  );
});
