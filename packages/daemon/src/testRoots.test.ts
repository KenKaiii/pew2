/**
 * The test script must actually reach every test.
 *
 * `bun test` cannot be pointed at the repo root here: scanning a tree this wide
 * exhausts file descriptors and spawned agents come back with empty pipes and a
 * success code (the `//test` note in the root `package.json` has the detail). So
 * the script names one source root per package instead — which buys a correct
 * suite at the cost of a list that can fall behind the packages it covers.
 *
 * A missing root is silent in the worst way: `bun test` reports every test it
 * ran as passing, and a new package's tests simply are not among them. Nobody
 * reads a green run and goes looking for the tests that did not appear in it.
 *
 * So the roots are read back out of the script rather than restated here. A copy
 * of the list in this file would be one more thing to forget to update, and it
 * would agree with itself while disagreeing with what CI runs.
 *
 * The one gap this cannot close is its own: a check that lives inside the suite
 * cannot notice that it was never run. Drop the root covering this file and both
 * tests below vanish silently, along with everything else under it. The second
 * test narrows that to the case worth catching — this file moved out from under
 * the roots while still being run — but what it ultimately rests on is CI
 * invoking `bun run test` rather than a path of its own.
 */
import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";

// Three levels up from `packages/daemon/src`. Asserted rather than assumed
// below, so moving this file fails loudly instead of quietly checking nothing.
const repoRoot = resolve(import.meta.dir, "../../..");

async function testScript(): Promise<string> {
  const manifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8")) as {
    name?: string;
    scripts?: Record<string, string>;
  };
  // Proves `repoRoot` is the root and not some directory that merely has a
  // package.json in it.
  expect(manifest.name).toBe("pew2");
  const script = manifest.scripts?.test;
  if (!script) throw new Error("root package.json has no test script");
  return script;
}

/**
 * The path arguments the script passes to `bun test`.
 *
 * Anything that is not a path is skipped: `bun`, `test`, and any flag. Bare
 * words are deliberately not treated as roots — `bun test packages` is a name
 * filter, which is the broken form this whole arrangement exists to avoid, so a
 * script written that way yields no roots and fails below rather than appearing
 * to cover everything.
 */
function rootsFrom(script: string): string[] {
  return script
    .split(/\s+/)
    .filter((token) => token.startsWith("./"))
    .map((token) => resolve(repoRoot, token));
}

async function testFiles(): Promise<string[]> {
  const glob = new Bun.Glob("packages/**/*.test.ts");
  const files: string[] = [];
  for await (const entry of glob.scan({ cwd: repoRoot, absolute: true })) {
    // Dependencies ship their own tests and are not ours to run.
    if (entry.includes("/node_modules/")) continue;
    files.push(entry);
  }
  return files.sort();
}

test("every test file lives under a root the test script names", async () => {
  const roots = rootsFrom(await testScript());
  const files = await testFiles();

  // Guards against both halves silently collapsing to nothing: no roots (a
  // script rewritten to the broken filter form) and no files (a glob that
  // stopped matching) would otherwise agree vacuously.
  expect(roots.length).toBeGreaterThan(0);
  expect(files.length).toBeGreaterThan(0);

  const orphans = files
    .filter((file) => !roots.some((root) => file.startsWith(`${root}/`)))
    .map((file) => relative(repoRoot, file));

  // Named rather than counted: the failure has to say which file is unreachable
  // and, by implication, which root is missing from the script.
  expect(orphans).toEqual([]);
});

test("this file sits under a root, so the check above is part of the suite", async () => {
  // Catches this file being moved somewhere the script does not reach. It cannot
  // catch the root being dropped instead — that stops this test running too — but
  // a move is the likelier accident, and silent without this.
  const roots = rootsFrom(await testScript());

  expect(roots.some((root) => import.meta.path.startsWith(`${root}/`))).toBe(true);
});
