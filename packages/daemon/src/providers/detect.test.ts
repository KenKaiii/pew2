/**
 * Detection tests.
 *
 * Everything runs against a temporary PATH and a temporary providers directory,
 * so the result never depends on what the machine running the suite happens to
 * have installed — which is exactly the property that makes detection worth
 * trusting in the first place.
 */
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CATALOG, detectProviders } from "./detect.js";
import { isAvailable, loadProviders, unavailableReason } from "./registry.js";
import { ProviderManifest } from "@pew2/protocol";

/** An isolated machine: an empty PATH, and nowhere any manifest already lives. */
async function sandbox() {
  const root = await mkdtemp(join(tmpdir(), "pew2-detect-"));
  const bin = join(root, "bin");
  const providers = join(root, "providers");
  await mkdir(bin, { recursive: true });
  return {
    root,
    bin,
    providers,
    env: { PATH: bin } as NodeJS.ProcessEnv,
  };
}

/** Put an executable on the sandbox PATH. */
async function install(bin: string, command: string) {
  const path = join(bin, command);
  await writeFile(path, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return path;
}

test("detects nothing on a machine with no agents installed", async () => {
  const { bin, providers, env } = await sandbox();

  const result = await detectProviders({
    env,
    targetDir: providers,
    searchDirs: [providers],
  });

  expect(result.detected).toEqual([]);
  // Every known adapter is reported as missing, with a way to get it — this is
  // what a coding agent reads to decide what to install next.
  expect(result.missing.map((m) => m.id).sort()).toEqual(CATALOG.map((c) => c.id).sort());
  for (const entry of result.missing) expect(entry.install.length).toBeGreaterThan(0);

  // Nothing was written: detection on a bare machine must not leave state behind.
  expect(await readdir(providers).catch(() => [])).toEqual([]);
  expect(bin).toBeTruthy();
});

test("an agent whose auth is gone is gated on its key, not silently spawned", async () => {
  // Google withdrew Sign-in-with-Google for Gemini Code Assist for individuals,
  // so an OAuth-only Gemini CLI now fails every request server-side. Marking
  // the key required turns that into a named, fixable precondition — and stops
  // the daemon spawning a process that can only fail, which was filling the
  // error log with an identical stack trace on every capability probe.
  const { bin, providers, env } = await sandbox();
  await install(bin, "gemini");
  // The manifest runs via npx, so without it on the sandbox PATH the provider
  // would read as unavailable for the wrong reason and hide what is being
  // tested here.
  await install(bin, "npx");

  await detectProviders({ env, targetDir: providers, searchDirs: [providers] });
  const { providers: loaded } = await loadProviders([providers], env);
  const gemini = loaded.find((p) => p.manifest.id === "gemini-cli")!;

  expect(gemini).toBeDefined();
  expect(isAvailable(gemini)).toBe(false);
  // Gated on the key specifically — the binary itself resolves fine.
  expect(gemini.commandMissing).toBe(false);
  expect(gemini.missingEnv).toEqual(["GEMINI_API_KEY"]);
  // The user has to be told which variable, or the gate is just a dead entry.
  expect(unavailableReason(gemini)).toContain("GEMINI_API_KEY");

  // With a key present it is usable again: this gates on configuration, it does
  // not retire the provider.
  const { providers: withKey } = await loadProviders([providers], {
    ...env,
    GEMINI_API_KEY: "test-key",
  } as NodeJS.ProcessEnv);
  expect(isAvailable(withKey.find((p) => p.manifest.id === "gemini-cli")!)).toBe(true);
});

test("writes a manifest that the registry can load and run", async () => {
  const { bin, providers, env } = await sandbox();
  const claude = await install(bin, "claude");

  const result = await detectProviders({
    env,
    targetDir: providers,
    searchDirs: [providers],
  });

  expect(result.detected).toHaveLength(1);
  const detected = result.detected[0]!;
  expect(detected).toMatchObject({
    id: "claude-code",
    action: "written",
    foundAt: claude,
  });
  expect(result.missing.some((m) => m.id === "claude-code")).toBe(false);

  // The point of the exercise: what detection wrote is a provider the daemon
  // can actually load, not merely a file on disk.
  const { providers: loaded, errors } = await loadProviders([providers], env);
  expect(errors).toEqual([]);
  expect(loaded.map((p) => p.manifest.id)).toEqual(["claude-code"]);
  expect(loaded[0]!.command).toBe("npx");
  expect(loaded[0]!.args).toContain("@agentclientprotocol/claude-agent-acp@latest");

  // Running again must be a no-op rather than a second manifest or an
  // overwrite, because an agent will loop on detect until it is satisfied.
  const again = await detectProviders({ env, targetDir: providers, searchDirs: [providers] });
  expect(again.detected).toEqual([
    { ...detected, action: "already-configured", manifestPath: join(providers, "claude-code.json") },
  ]);
  expect(await readdir(providers)).toEqual(["claude-code.json"]);
});

test("every catalog manifest is valid", () => {
  // A malformed catalog entry would only surface on the one machine that had
  // that agent installed, so it is checked here for all of them at once.
  for (const entry of CATALOG) {
    const parsed = ProviderManifest.safeParse(entry.manifest);
    expect(parsed.success ? entry.id : parsed.error.issues).toBe(entry.id);
    expect(parsed.success && parsed.data.id).toBe(entry.id);
  }
});

test("the catalog and the bundled manifests describe the same agent", async () => {
  // Every catalog entry that also ships as a file in providers/ states the same
  // facts twice, in two languages. Detection writes the catalog copy into
  // ~/.pew2/providers, where it *shadows* the bundled file — so if the two drift,
  // installing an agent silently changes how it launches, and only for the
  // people who ran detect. Pin the fields that decide that.
  const bundledDir = join(import.meta.dir, "..", "..", "..", "..", "providers");
  const { providers: bundled } = await loadProviders([bundledDir], {} as NodeJS.ProcessEnv);
  const byId = new Map(bundled.map((p) => [p.manifest.id, p.manifest]));

  const shared = CATALOG.filter((entry) => byId.has(entry.manifest.id));
  // Guard the guard. Filtering to the overlap means a typo'd or renamed id
  // silently drops out of the comparison, turning this into a test that passes
  // forever without checking anything — so assert the overlap itself.
  expect(shared.map((entry) => entry.manifest.id).sort()).toEqual(
    CATALOG.map((entry) => entry.manifest.id).sort(),
  );

  // Compared after parsing, so both sides have the schema's defaults applied
  // and an omitted field cannot read as a difference.
  const required = (m: ProviderManifest) =>
    m.pew.env
      .filter((v) => v.required)
      .map((v) => v.name)
      .sort();

  for (const entry of shared) {
    const file = byId.get(entry.manifest.id)!;
    const catalog = ProviderManifest.parse(entry.manifest);

    expect(catalog.distribution).toEqual(file.distribution);
    expect(catalog.pew.transport).toBe(file.pew.transport);
    expect(catalog.pew.color).toBe(file.pew.color);
    // Required env is what gates availability, so a disagreement here is the
    // difference between an agent that runs and one the app refuses to start.
    expect(required(catalog)).toEqual(required(file));
  }
});

test("every provider colour is legible on the app's dark surface", () => {
  // The colour is drawn as an Orb on `theme.color.surface`. A brand mark that is
  // near-black — OpenCode's and Cursor's both are — renders as an invisible dot,
  // which looks like a missing icon rather than a styling choice. Pinning the
  // contrast ratio keeps "use the real brand colour" from silently costing the
  // user the ability to tell two agents apart.
  //
  // Copied from the app's `theme.color.surface` rather than imported: the daemon
  // does not depend on the app, and inverting that for one hex string would be
  // the worse trade. If the app's surface is ever lightened substantially, this
  // constant is the thing to update.
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

  for (const entry of CATALOG) {
    const color = ProviderManifest.parse(entry.manifest).pew.color ?? "";
    // Also asserts a colour is set at all: an unstyled agent is a bug here, not
    // a default worth inheriting.
    expect(color).toMatch(/^#[0-9a-f]{6}$/);
    // 3:1 is the WCAG floor for a non-text graphic that carries meaning.
    expect({ id: entry.id, contrast: contrast(color) >= 3 }).toEqual({
      id: entry.id,
      contrast: true,
    });
  }
});

test("a user manifest shadows a bundled one instead of colliding", async () => {
  const { providers, env } = await sandbox();
  const bundled = join(providers, "bundled");
  const user = join(providers, "user");
  await mkdir(bundled, { recursive: true });
  await mkdir(user, { recursive: true });

  const manifest = (description: string) => ({
    id: "echo",
    name: "Echo",
    version: "0.1.0",
    description,
    distribution: { type: "command", command: "echo", args: [] },
  });
  await writeFile(join(bundled, "echo.json"), JSON.stringify(manifest("bundled")));
  await writeFile(join(user, "echo.json"), JSON.stringify(manifest("user")));

  const { providers: loaded, errors } = await loadProviders([user, bundled], env);
  expect(errors).toEqual([]);
  expect(loaded).toHaveLength(1);
  expect(loaded[0]!.manifest.description).toBe("user");
});
