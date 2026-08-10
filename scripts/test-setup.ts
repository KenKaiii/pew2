/**
 * Give the test run its own temp directory, and take it away again.
 *
 * Tests create scratch directories with `mkdtemp` constantly — a fake home for
 * the children registry, a session's attachment dir, a workspace to probe — and
 * essentially none of them remove what they made. `mkdtemp` has no lifetime and
 * the system tempdir is swept by the OS on a schedule measured in days, so a
 * repository whose suite runs dozens of times a day accumulates them without
 * limit: 27,645 directories and 257MB were sitting in `$TMPDIR` when this was
 * written.
 *
 * Rather than teaching a hundred call sites to clean up, the run is pointed at
 * a temp directory of its own. Everything lands inside it, and the whole tree
 * goes at exit — including the scratch files of a test that failed halfway, and
 * of a spawned agent that wrote somewhere under the same root.
 *
 * Loaded through `bunfig.toml`'s `[test] preload`, so it applies to `bun test`
 * and to nothing else. `Bun.spawn`/`node:child_process` pass `process.env` on by
 * default, so a spawned daemon or agent inherits the same root.
 */
import { afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Marks a root as ours, so a nested `bun test` does not create a second one. */
const ROOT_VAR = "PEW2_TEST_TMP_ROOT";

const inherited = process.env[ROOT_VAR];
if (inherited) {
  // A child process of a test run. It must write into the parent's root, and it
  // must not delete it on the way out — the parent is still using it.
  process.env.TMPDIR = inherited;
  process.env.TEMP = inherited;
  process.env.TMP = inherited;
} else {
  const root = mkdtempSync(join(tmpdir(), "pew2-test-run-"));
  process.env[ROOT_VAR] = root;
  // All three, because `os.tmpdir()` reads TMPDIR on POSIX and TEMP/TMP on
  // Windows, and both are consulted by different libraries on both platforms.
  process.env.TMPDIR = root;
  process.env.TEMP = root;
  process.env.TMP = root;

  // `afterAll` from a preload, not `process.on("exit")`: the test runner ends
  // the process without running exit hooks, so that version swept nothing at
  // all. A top-level hook in a preloaded file brackets the entire run.
  afterAll(() => {
    // Best effort: a temp directory that outlives one run is the ordinary state
    // this fixes, not a failure worth turning a green suite red over.
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // A file still held open by a child that outlived the run. The OS sweep
      // gets it eventually, which is where every one of these used to end up.
    }
  });
}
