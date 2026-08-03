/**
 * Syncing the official ACP Agent Registry into pew2 provider manifests.
 *
 * The registry (https://agentclientprotocol.com) publishes every ACP-speaking
 * agent as one JSON document, with pinned versions and — sometimes — sha256
 * hashes. Consuming it means a new agent becomes available to users without a
 * release of this app, which is the whole point: the curated CATALOG in
 * `detect.ts` can only ever be a snapshot of what someone remembered to add.
 *
 * Everything in this file is a pure transformation from registry JSON to
 * manifests. Fetching and writing live in the CLI, so the conversion — which is
 * where all the interesting mistakes are — can be tested without a network.
 *
 * Three rules shape the conversion:
 *
 *   1. `npx` and `uvx` entries convert directly. Those launchers fetch on
 *      demand, so nothing is downloaded here and nothing needs verifying.
 *   2. `binary` entries become `command` manifests naming the expected
 *      executable. They work the moment the user installs the agent by its own
 *      documented means, and are simply unavailable until then. This deliberately
 *      does not download anything as a side effect of syncing a list.
 *   3. A registry entry never overwrites a bundled manifest. Ours are
 *      hand-verified — the right probe name, a colour legible on the app's
 *      surface — and the registry has no equivalent fields to check.
 */
import { ProviderManifest, type ProviderManifestInput } from "@pew2/protocol";

/** One platform's binary for a registry `binary` distribution. */
export interface RegistryBinary {
  archive?: string;
  cmd?: string;
  args?: string[];
  sha256?: string;
  env?: Record<string, string>;
}

/** A single agent as published by the registry. */
export interface RegistryAgent {
  id: string;
  name: string;
  version: string;
  description?: string;
  repository?: string;
  website?: string;
  authors?: string[];
  license?: string;
  icon?: string;
  distribution: {
    npx?: { package: string; args?: string[] };
    uvx?: { package: string; args?: string[] };
    binary?: Record<string, RegistryBinary>;
  };
}

export interface RegistryDocument {
  version: string;
  agents: RegistryAgent[];
}

/**
 * Why one entry could not become a manifest.
 *
 * `kind` exists so callers can group these without matching on the prose.
 * "already bundled" is a normal, uninteresting outcome; "unsupported" means an
 * agent visible in the registry genuinely cannot run here, which is the only
 * kind worth putting in front of the user.
 */
export interface SkippedAgent {
  id: string;
  kind: "bundled" | "unsupported";
  reason: string;
}

export interface ConversionResult {
  manifests: ProviderManifest[];
  skipped: SkippedAgent[];
}

/**
 * Split a registry package spec into name and version.
 *
 * npm specs carry the version in the string (`@google/gemini-cli@0.53.1`), and
 * a scoped name starts with the same `@` — so the split has to be on the *last*
 * separator, and only when it is not the leading scope marker.
 */
export function splitNpmSpec(spec: string): { package: string; version: string } {
  const at = spec.lastIndexOf("@");
  if (at <= 0) return { package: spec, version: "latest" };
  return { package: spec.slice(0, at), version: spec.slice(at + 1) || "latest" };
}

/** PyPI pins with `==`, which cannot appear in a package name. */
export function splitPythonSpec(spec: string): { package: string; version: string } {
  const [name, version] = spec.split("==");
  return { package: name ?? spec, version: version || "latest" };
}

/**
 * The registry's key for the machine this is running on.
 *
 * Returns `undefined` on a platform the registry does not describe rather than
 * guessing: a wrong archive is worse than a missing one.
 */
export function platformKey(
  platform: string = process.platform,
  arch: string = process.arch,
): string | undefined {
  const os = { darwin: "darwin", linux: "linux", win32: "windows" }[platform];
  const cpu = { arm64: "aarch64", x64: "x86_64" }[arch];
  return os && cpu ? `${os}-${cpu}` : undefined;
}

/**
 * The executable name a `binary` entry will install as.
 *
 * Registry `cmd` values are paths inside the archive (`./goose`,
 * `./dist-package/cursor-agent`), so only the basename is meaningful once the
 * agent is installed normally and on PATH. A path with no usable basename —
 * a bare `./` — yields `undefined` rather than an empty command.
 */
export function binaryCommandName(cmd: string | undefined): string | undefined {
  if (!cmd) return undefined;
  const base = cmd.split("/").pop()?.trim();
  if (!base) return undefined;
  // Windows archives name the executable with a suffix that is not part of how
  // the command is invoked once installed.
  return base.replace(/\.exe$/i, "") || undefined;
}

/**
 * A deterministic colour for an agent, guaranteed legible on the app's surface.
 *
 * The registry publishes an icon but no colour, and there is no honest way to
 * infer a brand colour from an SVG URL without fetching and parsing it. Rather
 * than default every synced agent to one shared grey — which would make the
 * provider list unreadable at a glance — the hue is derived from the id and the
 * lightness is fixed high enough that contrast against `#1b1b1e` is a property
 * of the construction rather than something to remember to check.
 *
 * Stable across runs, so a synced provider does not change colour on refresh.
 */
export function colorForId(id: string): string {
  // FNV-1a: tiny, and far better distributed across short strings than a sum of
  // char codes, which would cluster anagrams and similar names onto one hue.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  const hue = Math.abs(hash) % 360;
  // L=70% keeps every hue above 3:1 on the app's #1b1b1e surface; S=60% keeps
  // them distinguishable without looking like warning states.
  return hslToHex(hue, 0.6, 0.7);
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = (
    [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x],
    ] as const
  )[Math.floor(h / 60) % 6]!;
  const channel = (v: number) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, "0");
  return `#${channel(r)}${channel(g)}${channel(b)}`;
}

/**
 * What a manifest actually launches, stripped of how it is packaged.
 *
 * The registry names agents differently than we do — `gemini` for our
 * `gemini-cli`, `cursor` for our `cursor-agent`, `codex-acp` for our `codex` —
 * so excluding bundled agents by id alone would list several of them twice, once
 * under each name. Comparing what gets run instead of what it is called catches
 * those without a hand-maintained alias table that would go stale the first time
 * the registry renamed something.
 *
 * npm scopes and the `-ai`-style suffixes publishers add to claim a package name
 * are dropped, since neither says anything about the program being started.
 */
export function launchIdentity(distribution: {
  type: string;
  package?: string;
  command?: string;
}): string {
  const raw =
    distribution.type === "command"
      ? (distribution.command ?? "")
      : (distribution.package ?? "").split("/").pop() ?? "";
  return raw
    .replace(/\.exe$/i, "")
    .replace(/-(ai|cli|code|acp|agent)$/i, "")
    .toLowerCase();
}

/** Registry ids are looser than ours; normalise rather than reject. */
function normaliseId(id: string): string | undefined {
  const cleaned = id
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return /^[a-z]/.test(cleaned) ? cleaned : undefined;
}

/**
 * Convert one registry agent into a manifest.
 *
 * Returns a reason instead of a manifest when the entry cannot be run on this
 * platform, so the caller can tell the user *why* an agent they can see in the
 * registry did not appear.
 *
 * `platform` is required rather than defaulted: `undefined` is a meaningful
 * value here — a machine the registry has no builds for — and a default would
 * quietly turn that case into the host's own platform, which is both wrong and
 * impossible to test.
 */
export function toManifest(
  agent: RegistryAgent,
  platform: string | undefined,
): ProviderManifest | SkippedAgent {
  const id = normaliseId(agent.id);
  if (!id) {
    return { id: agent.id, kind: "unsupported", reason: "id is not usable as a provider id" };
  }

  const dist = agent.distribution;
  let distribution: ProviderManifestInput["distribution"] | undefined;

  if (dist.npx) {
    const { package: pkg, version } = splitNpmSpec(dist.npx.package);
    distribution = { type: "npx", package: pkg, version, args: dist.npx.args ?? [] };
  } else if (dist.uvx) {
    const { package: pkg, version } = splitPythonSpec(dist.uvx.package);
    distribution = { type: "uvx", package: pkg, version, args: dist.uvx.args ?? [] };
  } else if (dist.binary) {
    if (!platform) {
      return { id, kind: "unsupported", reason: "no registry build for this platform" };
    }
    const build = dist.binary[platform];
    if (!build) return { id, kind: "unsupported", reason: `no ${platform} build` };
    const command = binaryCommandName(build.cmd);
    if (!command) return { id, kind: "unsupported", reason: "build declares no command" };
    // Deliberately a plain `command`: the archive is not downloaded here, so the
    // agent is available once installed by its own documented means and shows as
    // "not installed" until then.
    distribution = { type: "command", command, args: build.args ?? [] };
  } else {
    return { id, kind: "unsupported", reason: "no supported distribution" };
  }

  const input: ProviderManifestInput = {
    id,
    name: agent.name,
    // The registry pins the agent's own version; the manifest's version
    // describes this description of it, and every synced manifest is v1 of that.
    version: "1.0.0",
    description: agent.description?.trim() || agent.name,
    distribution,
    // `repository` must be a URL to validate, and some entries only publish a
    // website. Either is more useful than nothing when an agent misbehaves.
    repository: agent.repository ?? agent.website,
    authors: agent.authors ?? [],
    license: agent.license,
    pew: { transport: "acp", color: colorForId(id) },
  };

  const parsed = ProviderManifest.safeParse(input);
  if (!parsed.success) {
    return {
      id,
      kind: "unsupported",
      reason: parsed.error.issues[0]?.message ?? "failed validation",
    };
  }
  return parsed.data;
}

/**
 * Convert a whole registry document.
 *
 * `exclude` holds the manifests that already ship with pew2. Those are skipped
 * rather than converted: a synced manifest lands in the user directory, which
 * *shadows* the bundled one, so converting them would silently replace a
 * hand-verified entry with a generated one.
 *
 * Matching is by id *and* by what the manifest launches, because the registry
 * frequently uses a different name for an agent we already ship.
 */
export function toManifests(
  doc: RegistryDocument,
  exclude: Iterable<string | { id: string; distribution: Parameters<typeof launchIdentity>[0] }> = [],
  platform: string | undefined = platformKey(),
): ConversionResult {
  const manifests: ProviderManifest[] = [];
  const skipped: SkippedAgent[] = [];

  const excludedIds = new Set<string>();
  const excludedLaunches = new Set<string>();
  for (const entry of exclude) {
    if (typeof entry === "string") {
      excludedIds.add(entry);
    } else {
      excludedIds.add(entry.id);
      // An empty identity would match everything that reduces to nothing, so a
      // single malformed bundled manifest could silently suppress unrelated
      // agents. Ids are compared literally and are unaffected.
      const launch = launchIdentity(entry.distribution);
      if (launch) excludedLaunches.add(launch);
    }
  }

  for (const agent of doc.agents) {
    const result = toManifest(agent, platform);
    if ("reason" in result) {
      skipped.push(result);
      continue;
    }
    if (excludedIds.has(agent.id) || excludedIds.has(result.id)) {
      skipped.push({ id: agent.id, kind: "bundled", reason: "already bundled" });
      continue;
    }
    if (excludedLaunches.has(launchIdentity(result.distribution))) {
      skipped.push({ id: agent.id, kind: "bundled", reason: "already bundled under another name" });
      continue;
    }
    manifests.push(result);
  }

  manifests.sort((a, b) => a.id.localeCompare(b.id));
  skipped.sort((a, b) => a.id.localeCompare(b.id));
  return { manifests, skipped };
}

/**
 * Validate a fetched document before trusting its shape.
 *
 * Loose on purpose: the registry may add fields, and refusing to sync because
 * of an unknown key would make this brittle in exactly the way that defeats the
 * point. Only the parts actually read are checked.
 */
export function parseRegistry(raw: unknown): RegistryDocument {
  if (typeof raw !== "object" || raw === null) throw new Error("registry is not an object");
  const doc = raw as Partial<RegistryDocument>;
  if (!Array.isArray(doc.agents)) throw new Error("registry has no agents array");

  const agents = doc.agents.filter(
    (a): a is RegistryAgent =>
      typeof a === "object" &&
      a !== null &&
      typeof (a as RegistryAgent).id === "string" &&
      typeof (a as RegistryAgent).name === "string" &&
      typeof (a as RegistryAgent).distribution === "object",
  );

  return { version: typeof doc.version === "string" ? doc.version : "unknown", agents };
}
