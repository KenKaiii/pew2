/**
 * Registry conversion.
 *
 * This is the code that decides what a user sees in their provider list after a
 * sync, from a document nobody here controls. Its failure modes are quiet: a
 * mis-split package spec produces a manifest that validates cleanly and then
 * fails at spawn, and a colour chosen badly produces an invisible dot rather
 * than an error. Both are pinned below.
 */
import { expect, test } from "bun:test";
import {
  binaryCommandName,
  colorForId,
  parseRegistry,
  platformKey,
  splitNpmSpec,
  splitPythonSpec,
  toManifest,
  toManifests,
  type RegistryAgent,
} from "./acp-registry.js";

const agent = (overrides: Partial<RegistryAgent> = {}): RegistryAgent => ({
  id: "example",
  name: "Example",
  version: "1.2.3",
  description: "An example agent",
  distribution: { npx: { package: "example@1.2.3", args: ["--acp"] } },
  ...overrides,
});

test("a scoped npm package keeps its scope when the version is split off", () => {
  // The scope marker and the version separator are the same character, so a
  // naive split turns `@google/gemini-cli@0.53.1` into the package `` and a
  // manifest that validates but can never spawn.
  expect(splitNpmSpec("@google/gemini-cli@0.53.1")).toEqual({
    package: "@google/gemini-cli",
    version: "0.53.1",
  });
  expect(splitNpmSpec("cline@3.0.49")).toEqual({ package: "cline", version: "3.0.49" });
  // Unpinned, and a bare scoped name with no version at all.
  expect(splitNpmSpec("cline")).toEqual({ package: "cline", version: "latest" });
  expect(splitNpmSpec("@scope/pkg")).toEqual({ package: "@scope/pkg", version: "latest" });
});

test("python pins split on == rather than the npm separator", () => {
  expect(splitPythonSpec("fast-agent-acp==0.9.30")).toEqual({
    package: "fast-agent-acp",
    version: "0.9.30",
  });
  expect(splitPythonSpec("minion-code")).toEqual({ package: "minion-code", version: "latest" });
});

test("a binary entry becomes the command it installs as", () => {
  // Registry `cmd` values are paths inside the archive. Only the basename is
  // meaningful once the user has installed the agent normally.
  expect(binaryCommandName("./goose")).toBe("goose");
  expect(binaryCommandName("./dist-package/cursor-agent")).toBe("cursor-agent");
  expect(binaryCommandName("./bin/devin.exe")).toBe("devin");
  // Nothing usable is better than an empty command that spawns the shell.
  expect(binaryCommandName("./")).toBeUndefined();
  expect(binaryCommandName(undefined)).toBeUndefined();
});

test("a binary agent converts for this platform and is skipped for others", () => {
  const goose = agent({
    id: "goose",
    distribution: {
      binary: {
        "darwin-aarch64": { archive: "https://example.com/g.tar.bz2", cmd: "./goose", args: ["acp"] },
      },
    },
  });

  const mac = toManifest(goose, "darwin-aarch64");
  expect("reason" in mac).toBe(false);
  expect((mac as { distribution: unknown }).distribution).toEqual({
    type: "command",
    command: "goose",
    args: ["acp"],
  });

  // The archive is never downloaded as a side effect of syncing a list, so an
  // agent with no build for this machine is reported, not guessed at.
  const linux = toManifest(goose, "linux-x86_64");
  expect(linux).toEqual({ id: "goose", kind: "unsupported", reason: "no linux-x86_64 build" });
  expect(toManifest(goose, undefined)).toEqual({
    id: "goose",
    kind: "unsupported",
    reason: "no registry build for this platform",
  });
});

test("an agent with no distribution we can run is reported, not dropped silently", () => {
  const result = toManifest(agent({ distribution: {} }), "darwin-aarch64");
  expect(result).toEqual({ id: "example", kind: "unsupported", reason: "no supported distribution" });
});

test("bundled manifests are never replaced by their registry twin", () => {
  // A synced manifest lands in the user directory, which *shadows* the bundled
  // one — so converting an id we already ship would silently swap a
  // hand-verified entry (right probe name, checked colour) for a generated one.
  const doc = {
    version: "1.0.0",
    agents: [agent({ id: "goose" }), agent({ id: "kimi" })],
  };

  // Exercised the way the CLI calls it — with the bundled manifests themselves,
  // not a set of ids — so the test covers the path that actually runs.
  const { manifests, skipped } = toManifests(
    doc,
    [{ id: "goose", distribution: { type: "command", command: "goose" } }],
    "darwin-aarch64",
  );
  expect(manifests.map((m) => m.id)).toEqual(["kimi"]);
  expect(skipped).toEqual([{ id: "goose", kind: "bundled", reason: "already bundled" }]);

  // Bare ids remain supported, since an id is sometimes all a caller has.
  expect(toManifests(doc, ["goose"], "darwin-aarch64").manifests.map((m) => m.id)).toEqual([
    "kimi",
  ]);
});

test("registry ids that are not valid provider ids are normalised or refused", () => {
  expect((toManifest(agent({ id: "Cortex_Code" }), "darwin-aarch64") as { id: string }).id).toBe("cortex-code");
  // Leading digit: our ids must start with a letter, and inventing a prefix
  // would break the link back to the registry entry.
  expect(toManifest(agent({ id: "3rd-party" }), "darwin-aarch64")).toEqual({
    id: "3rd-party",
    kind: "unsupported",
    reason: "id is not usable as a provider id",
  });
});

test("a registry entry missing optional fields still produces a valid manifest", () => {
  // The registry only guarantees id, name and distribution. Everything else has
  // to survive being absent, since one sparse entry must not fail the sync.
  const sparse = toManifest({
    id: "sparse",
    name: "Sparse",
    version: "0.1.0",
    distribution: { npx: { package: "sparse" } },
  }, "darwin-aarch64");

  expect("reason" in sparse).toBe(false);
  const manifest = sparse as { description: string; repository?: string; authors: string[] };
  expect(manifest.description).toBe("Sparse");
  expect(manifest.repository).toBeUndefined();
  expect(manifest.authors).toEqual([]);
});

test("website stands in for a missing repository, and neither is invented", () => {
  const withSite = toManifest(agent({ repository: undefined, website: "https://cursor.com/docs" }), "darwin-aarch64");
  expect((withSite as { repository?: string }).repository).toBe("https://cursor.com/docs");

  // A non-URL would fail schema validation; the entry must be skipped with a
  // reason rather than take the whole sync down.
  const bad = toManifest(agent({ repository: "not a url", website: undefined }), "darwin-aarch64");
  expect("reason" in bad).toBe(true);
});

test("generated colours are stable and legible on the app's surface", () => {
  const SURFACE = "#1b1b1e";
  const luminance = (hex: string) => {
    const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16) / 255);
    const channel = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * channel(r!) + 0.7152 * channel(g!) + 0.0722 * channel(b!);
  };
  const contrast = (hex: string) => {
    const [a, b] = [luminance(hex), luminance(SURFACE)].sort((x, y) => y - x);
    return (a! + 0.05) / (b! + 0.05);
  };

  // Stable: a synced provider must not change colour every refresh.
  expect(colorForId("goose")).toBe(colorForId("goose"));
  expect(colorForId("goose")).not.toBe(colorForId("kimi"));

  // Legible by construction rather than by review. The registry publishes no
  // colour, so this runs for every agent that will ever be synced — checking a
  // wide sample is the only way to know the construction holds.
  for (let i = 0; i < 500; i++) {
    const color = colorForId(`agent-${i.toString(36)}`);
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
    expect({ color, legible: contrast(color) >= 3 }).toEqual({ color, legible: true });
  }
});

test("platform keys match the registry's spelling, and unknown ones are undefined", () => {
  expect(platformKey("darwin", "arm64")).toBe("darwin-aarch64");
  expect(platformKey("linux", "x64")).toBe("linux-x86_64");
  expect(platformKey("win32", "x64")).toBe("windows-x86_64");
  // A wrong archive is worse than a missing one.
  expect(platformKey("freebsd", "x64")).toBeUndefined();
  expect(platformKey("darwin", "ia32")).toBeUndefined();
});

test("a malformed registry fails loudly, but unknown fields do not", () => {
  expect(() => parseRegistry(null)).toThrow("not an object");
  expect(() => parseRegistry({ version: "1.0.0" })).toThrow("no agents array");

  // Forward compatibility: the registry adding a field must not stop a sync,
  // which is the failure that would make this feature worse than the hardcoded
  // list it replaces.
  const doc = parseRegistry({
    version: "2.0.0",
    somethingNew: true,
    agents: [{ ...agent(), unknownField: 1 }, { id: "broken" }],
  });
  expect(doc.agents).toHaveLength(1);
  expect(doc.agents[0]!.id).toBe("example");
});
