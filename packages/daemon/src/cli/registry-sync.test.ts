/**
 * Registry sync.
 *
 * The properties worth protecting are about *not* losing things: a manifest the
 * user edited, a bundled agent that the registry happens to name differently,
 * and the ability to run the command twice without it undoing itself.
 */
import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundledEntries, fetchRegistry, syncRegistry } from "./registry-sync.js";

async function tempDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), "pew2-sync-"));
}

const doc = {
  version: "1.0.0",
  agents: [
    {
      id: "kimi",
      name: "Kimi",
      version: "1.0.0",
      description: "Moonshot's assistant",
      distribution: { npx: { package: "kimi@1.2.3", args: ["--acp"] } },
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      version: "0.53.1",
      description: "Google's CLI",
      distribution: { npx: { package: "@google/gemini-cli@0.53.1", args: ["--acp"] } },
    },
  ],
};

test("writes one manifest per agent, and reads back as valid JSON", async () => {
  const targetDir = await tempDir();
  const result = await syncRegistry({ raw: doc, targetDir, bundled: [], platform: "darwin-aarch64" });

  expect(result.written.sort()).toEqual(["gemini", "kimi"]);
  expect(await readdir(targetDir)).toHaveLength(2);

  const written = JSON.parse(await readFile(join(targetDir, "kimi.json"), "utf8"));
  expect(written.id).toBe("kimi");
  expect(written.distribution).toEqual({
    type: "npx",
    package: "kimi",
    version: "1.2.3",
    args: ["--acp"],
  });
  // No `$schema`: the bundled manifests point at a repo-relative path that means
  // nothing from the user's provider directory.
  expect(written.$schema).toBeUndefined();
});

test("running twice changes nothing the second time", async () => {
  // A sync that reported every file as a conflict on the second run would be
  // one nobody dares re-run, which defeats the point of tracking a live registry.
  const targetDir = await tempDir();
  const options = { raw: doc, targetDir, bundled: [], platform: "darwin-aarch64" };

  await syncRegistry(options);
  const second = await syncRegistry(options);

  expect(second.written).toEqual([]);
  expect(second.unchanged.sort()).toEqual(["gemini", "kimi"]);
  expect(second.conflicts).toEqual([]);
});

test("a locally edited manifest is never silently overwritten", async () => {
  const targetDir = await tempDir();
  await syncRegistry({ raw: doc, targetDir, bundled: [], platform: "darwin-aarch64" });

  // The user adds an API key requirement to a synced manifest.
  const path = join(targetDir, "kimi.json");
  const edited = JSON.parse(await readFile(path, "utf8"));
  edited.pew.env = [{ name: "MOONSHOT_API_KEY", required: true }];
  await writeFile(path, JSON.stringify(edited, null, 2));

  const result = await syncRegistry({ raw: doc, targetDir, bundled: [], platform: "darwin-aarch64" });
  expect(result.conflicts).toEqual(["kimi"]);
  expect(result.written).toEqual([]);
  // Still theirs.
  expect(JSON.parse(await readFile(path, "utf8")).pew.env).toHaveLength(1);

  // --force is the explicit way to say otherwise.
  const forced = await syncRegistry({
    raw: doc,
    targetDir,
    bundled: [],
    platform: "darwin-aarch64",
    force: true,
  });
  expect(forced.written).toEqual(["kimi"]);
  expect(JSON.parse(await readFile(path, "utf8")).pew.env).toEqual([]);
});

test("an agent we already ship is skipped even when the registry renames it", async () => {
  // The registry calls our `gemini-cli` just `gemini`. Excluding by id alone
  // would list the same agent twice, once under each name.
  const targetDir = await tempDir();
  const result = await syncRegistry({
    raw: doc,
    targetDir,
    bundled: [
      {
        id: "gemini-cli",
        distribution: { type: "npx", package: "@google/gemini-cli" },
      },
    ],
    platform: "darwin-aarch64",
  });

  expect(result.written).toEqual(["kimi"]);
  expect(result.skipped).toContainEqual({
    id: "gemini",
    kind: "bundled",
    reason: "already bundled under another name",
  });
});

test("a dry run reports exactly what a real run would write, and writes nothing", async () => {
  const targetDir = await tempDir();
  const preview = await syncRegistry({
    raw: doc,
    targetDir,
    bundled: [],
    platform: "darwin-aarch64",
    dryRun: true,
  });

  expect(preview.written.sort()).toEqual(["gemini", "kimi"]);
  await expect(readdir(targetDir)).resolves.toEqual([]);
});

test("a malformed bundled manifest cannot suppress unrelated agents", async () => {
  // A distribution that reduces to an empty launch identity must not match
  // everything: one broken file in the bundled directory would otherwise
  // silently swallow agents that have nothing to do with it.
  const targetDir = await tempDir();
  const result = await syncRegistry({
    raw: doc,
    targetDir,
    bundled: [{ id: "broken", distribution: { type: "command", command: "" } }],
    platform: "darwin-aarch64",
  });

  expect(result.written.sort()).toEqual(["gemini", "kimi"]);
});

test("bundled entries are read from disk, and a broken one does not stop the rest", async () => {
  const dir = await tempDir();
  await writeFile(
    join(dir, "good.json"),
    JSON.stringify({ id: "good", distribution: { type: "command", command: "good" } }),
  );
  await writeFile(join(dir, "broken.json"), "{ not json");
  await writeFile(join(dir, "notes.txt"), "ignored");

  const entries = await bundledEntries(dir);
  expect(entries.map((e) => e.id)).toEqual(["good"]);

  // A missing directory means nothing is protected, not a crash.
  await expect(bundledEntries(join(dir, "nope"))).resolves.toEqual([]);
});

test("a registry that does not respond fails with a usable message", async () => {
  // Distinct from a malformed document: this is the offline case, and the
  // command has to say so rather than reporting an empty registry.
  await expect(
    fetchRegistry("https://example.com/r.json", async () => new Response("", { status: 503 })),
  ).rejects.toThrow("503");
});

test("the target directory is only created when there is something to write", async () => {
  // A dry run, or a registry where everything is already bundled, should not
  // leave an empty directory behind as a side effect of asking a question.
  const root = await tempDir();
  const targetDir = join(root, "providers");

  await syncRegistry({
    raw: { version: "1.0.0", agents: [] },
    targetDir,
    bundled: [],
    platform: "darwin-aarch64",
  });

  await expect(readdir(targetDir)).rejects.toThrow();
});
