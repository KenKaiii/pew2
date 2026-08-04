/**
 * The embedded manifest list against the directory it mirrors.
 *
 * A manifest that exists in `providers/` but not in `bundled.ts` works
 * perfectly from a checkout and then vanishes in the shipped binary, where the
 * directory cannot be read. That is the worst shape of bug for this project:
 * invisible in development, and on a user's machine it looks like the agent
 * simply is not supported.
 */
import { expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { BUNDLED_MANIFESTS } from "./bundled.js";
import { defaultProvidersDir, loadProviders } from "./registry.js";

test("every manifest on disk is embedded in the binary", async () => {
  const dir = defaultProvidersDir();
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));

  const onDisk = await Promise.all(
    files.map(async (f) => JSON.parse(await readFile(join(dir, f), "utf8")).id as string),
  );
  const embedded = BUNDLED_MANIFESTS.map((m) => (m as { id: string }).id);

  expect(embedded.sort()).toEqual(onDisk.sort());
});

test("the embedded manifests are byte-identical to the files", async () => {
  // Catches the subtler drift: an id present in both, but the embedded copy
  // stale after someone edited the JSON. The command a provider launches lives
  // in here, so a stale copy spawns the wrong thing.
  const dir = defaultProvidersDir();

  for (const manifest of BUNDLED_MANIFESTS) {
    const id = (manifest as { id: string }).id;
    const raw = JSON.parse(await readFile(join(dir, `${id}.json`), "utf8"));
    expect({ id, manifest }).toEqual({ id, manifest: raw });
  }
});

test("a directory that does not exist still leaves the built-in agents", async () => {
  // What a compiled binary on a fresh machine does: nothing in
  // `~/.pew2/providers`, no checkout anywhere. It must still know its agents.
  //
  // Naming directories is opt-out of the built-ins, so this asks for them back
  // explicitly — which is exactly what the production callers do.
  const { providers, errors } = await loadProviders(
    ["/nonexistent/pew2/providers"],
    {} as NodeJS.ProcessEnv,
    { bundled: true },
  );

  expect(errors).toEqual([]);
  expect(providers.length).toBe(BUNDLED_MANIFESTS.length);
  expect(providers.map((p) => p.manifest.id)).toContain("claude-code");
});

test("naming a directory means that directory and nothing else", () => {
  // The isolation every other test in this repo depends on: pointing at a
  // sandbox must not silently mix in thirteen real agents.
  return loadProviders(["/nonexistent/pew2/providers"], {} as NodeJS.ProcessEnv).then((r) => {
    expect(r.providers).toEqual([]);
  });
});

test("a user manifest still shadows the bundled one with the same id", async () => {
  // Precedence has to survive the move from directory to array, or someone's
  // local override silently stops applying.
  const { providers } = await loadProviders([defaultProvidersDir()], {} as NodeJS.ProcessEnv);
  const echo = providers.filter((p) => p.manifest.id === "echo");

  // Exactly one, and it came from the directory rather than the embedded copy.
  expect(echo).toHaveLength(1);
  expect(echo[0]!.source.startsWith("bundled:")).toBe(false);
});
