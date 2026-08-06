/**
 * Browsing for a project to start in.
 *
 * Two things are being protected here, and the second matters more than it
 * looks. The first is that the feature works: an agent with no history has no
 * project list, so without this there is no way to start it at all. The second
 * is that it stays inside its allowlist — the pairing token is a bearer secret
 * carried over a public relay, and a stolen one must not become the ability to
 * enumerate someone's disk.
 */
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverRepos, listDirectory, resolveBrowsePath } from "./workspaces.js";

/**
 * A home directory with a few projects in it.
 *
 * `realpath` on the way out, because everything under test returns resolved
 * paths and macOS puts temp directories behind the `/var -> /private/var`
 * symlink. Comparing against the unresolved spelling would fail for a reason
 * that has nothing to do with the behaviour being tested — and worse, would
 * tempt someone to "fix" it by relaxing the containment check.
 */
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), "pew2-ws-")));
  const repo = async (path: string) => {
    await mkdir(join(home, path), { recursive: true });
    await mkdir(join(home, path, ".git"), { recursive: true });
  };

  await repo("code/api");
  await repo("code/web");
  await repo("deep/one/two/buried");
  await mkdir(join(home, "code/notes"), { recursive: true });
  await mkdir(join(home, "Library/Caches"), { recursive: true });

  return { home, roots: [home] };
}

test("repositories are found without walking into their contents", async () => {
  const { home, roots } = await fixture();
  // A repo's own node_modules can hold a vendored checkout; descending into one
  // finds projects the user never meant and is most of what makes a scan slow.
  await mkdir(join(home, "code/api/node_modules/dep/.git"), { recursive: true });

  const found = await discoverRepos({ roots });
  const paths = found.map((entry) => entry.path);

  expect(paths).toContain(join(home, "code/api"));
  expect(paths).toContain(join(home, "code/web"));
  expect(paths.some((path) => path.includes("node_modules"))).toBe(false);
  // A plain directory is not a suggestion; it is still reachable by browsing.
  expect(paths).not.toContain(join(home, "code/notes"));
});

test("the scan stops at a sensible depth and skips noise directories", async () => {
  const { home, roots } = await fixture();

  const shallow = await discoverRepos({ roots, depth: 2 });
  expect(shallow.map((e) => e.path)).not.toContain(join(home, "deep/one/two/buried"));

  const deeper = await discoverRepos({ roots, depth: 4 });
  expect(deeper.map((e) => e.path)).toContain(join(home, "deep/one/two/buried"));

  // `Library` is skipped at every depth: it is enormous and holds no projects.
  await mkdir(join(home, "Library/Caches/thing/.git"), { recursive: true });
  const all = await discoverRepos({ roots, depth: 5 });
  expect(all.map((e) => e.path).some((p) => p.includes("Library"))).toBe(false);
});

test("suggestions are ordered by recency, because that is how projects are chosen", async () => {
  // Times are set explicitly rather than by writing a file and hoping. The
  // fixture's repos are created microseconds apart, so where mtimes are stamped
  // to the second — CI runners do this, and this machine does not — they all
  // land on the same timestamp, the sort has nothing to order by, and the
  // result falls back to discovery order. That is how this passed everywhere it
  // was run by hand and failed on CI with `api` first.
  const older = new Date("2026-01-01T00:00:00Z");
  const newer = new Date("2026-06-01T00:00:00Z");

  /**
   * The two repos this test set times on, in the order they were returned.
   *
   * Filtered rather than compared whole: the fixture also holds a deeply nested
   * repo, and whether the scan reaches it is a depth question this test has no
   * opinion about. Asserting the entire list would fail on a change to that
   * limit while saying nothing about ordering.
   */
  const order = async (roots: string[]) =>
    (await discoverRepos({ roots }))
      .map((entry) => entry.path.split("/").pop())
      .filter((name) => name === "api" || name === "web");

  // Asserted both ways round, because one arrangement or the other must
  // disagree with whatever order the scan happened to find them in. A single
  // arrangement cannot tell "sorted by recency" apart from "listed as found" —
  // exactly the hole that let this flake through.
  const web = await fixture();
  await utimes(join(web.home, "code/api"), older, older);
  await utimes(join(web.home, "code/web"), newer, newer);
  expect(await order(web.roots)).toEqual(["web", "api"]);

  const api = await fixture();
  await utimes(join(api.home, "code/api"), newer, newer);
  await utimes(join(api.home, "code/web"), older, older);
  expect(await order(api.roots)).toEqual(["api", "web"]);
});

test("browsing lists directories only, and marks the ones that are repositories", async () => {
  const { home, roots } = await fixture();
  await writeFile(join(home, "code/README.md"), "# x");

  const listing = await listDirectory(join(home, "code"), { roots, home });
  expect(listing).toBeDefined();

  const names = listing!.entries.map((entry) => entry.name);
  // A file cannot be a working directory, so listing it only buries the folders.
  expect(names).not.toContain("README.md");
  expect(names.sort()).toEqual(["api", "notes", "web"]);
  expect(listing!.entries.find((e) => e.name === "api")?.repo).toBe(true);
  expect(listing!.entries.find((e) => e.name === "notes")?.repo).toBe(false);
});

test("the parent link stops at the root rather than offering a dead row", async () => {
  const { home, roots } = await fixture();

  const nested = await listDirectory(join(home, "code"), { roots, home });
  expect(nested!.parent).toBe(home);

  // At the top there is nowhere allowed to go up to, and offering one would be
  // a row that can only fail when tapped.
  const top = await listDirectory(home, { roots, home });
  expect(top!.parent).toBeUndefined();
});

test("paths outside the allowlist are refused, however they are spelled", async () => {
  const { home, roots } = await fixture();

  for (const attempt of [
    "/etc",
    "/",
    join(home, "..", "..", "etc"),
    join(home, "code", "..", "..", "..", "etc", "passwd"),
    "relative/path",
    "",
  ]) {
    expect(await resolveBrowsePath(attempt, roots, home)).toBeUndefined();
  }

  // And the refusal is a refusal, not an empty listing that implies existence.
  expect(await listDirectory("/etc", { roots, home })).toBeUndefined();
});

test("the scan does not follow a symlink out of the allowlist", async () => {
  // The scan walks directories itself, so containment has to be re-checked at
  // every step and not only when a client names a path. A link inside home
  // pointing at another volume — `~/code -> /Volumes/work` — would otherwise be
  // traversed, and repositories from anywhere on the machine reported to the
  // phone as suggestions.
  const { home, roots } = await fixture();
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "pew2-outside-")));
  await mkdir(join(elsewhere, "private-repo", ".git"), { recursive: true });
  await symlink(elsewhere, join(home, "linked"));

  const found = await discoverRepos({ roots });
  expect(found.map((entry) => entry.path)).not.toContain(join(elsewhere, "private-repo"));
  // The repos inside home are still found: a containment check that refused
  // everything would satisfy the assertion below without protecting anything.
  expect(found.map((entry) => entry.path)).toContain(join(home, "code/api"));
  // And nothing at all from outside, however it was reached.
  expect(found.every((entry) => entry.path.startsWith(home))).toBe(true);
});

test("a symlink cannot be used to step outside the allowlist", async () => {
  // The bypass this is here to stop: a link *inside* home pointing anywhere,
  // which passes a naive prefix check because the path it is asked about does
  // begin with home. Resolution therefore happens before the check.
  const { home, roots } = await fixture();
  await symlink("/etc", join(home, "escape"));

  expect(await resolveBrowsePath(join(home, "escape"), roots, home)).toBeUndefined();
  expect(await listDirectory(join(home, "escape"), { roots, home })).toBeUndefined();
});

test("a tilde path resolves, since that is how a person writes their home", async () => {
  const { home, roots } = await fixture();
  expect(await resolveBrowsePath("~", roots, home)).toBe(home);
  expect(await resolveBrowsePath("~/code", roots, home)).toBe(join(home, "code"));
});

test("a file, or something that does not exist, is refused rather than listed", async () => {
  const { home, roots } = await fixture();
  await writeFile(join(home, "notes.txt"), "x");

  expect(await listDirectory(join(home, "notes.txt"), { roots, home })).toBeUndefined();
  expect(await listDirectory(join(home, "nope"), { roots, home })).toBeUndefined();
});

test("the scan is bounded, so an enormous home cannot hang the daemon", async () => {
  const { home, roots } = await fixture();
  for (let i = 0; i < 40; i++) await mkdir(join(home, `wide/dir-${i}`), { recursive: true });

  // The limit counts directories examined, not results, so it bounds the work
  // even when almost nothing matches.
  const found = await discoverRepos({ roots, scanLimit: 5 });
  expect(found.length).toBeLessThanOrEqual(5);
});
