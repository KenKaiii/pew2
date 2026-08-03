/**
 * `pew2 registry sync` — pull the official ACP Agent Registry.
 *
 * The curated catalog in `detect.ts` can only ever be a snapshot of what
 * someone remembered to add. This makes new agents available without a release,
 * which is the difference between supporting a dozen agents and supporting the
 * ecosystem.
 *
 * What it deliberately does *not* do is download anything executable. Registry
 * `binary` entries become ordinary `command` manifests naming the executable the
 * agent installs as, so they light up once the user installs the agent by its
 * own documented means. Half the registry's binary builds publish no sha256 at
 * all, so a sync that fetched and ran them would be executing unverified code as
 * a side effect of refreshing a list.
 */
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseRegistry,
  platformKey,
  toManifests,
  type SkippedAgent,
} from "../providers/acp-registry.js";
import { defaultProvidersDir, userProvidersDir } from "../providers/registry.js";
import type { ProviderManifest } from "@pew2/protocol";

export const REGISTRY_URL = "https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json";

/** How long to wait before deciding the registry is not reachable. */
const FETCH_TIMEOUT_MS = 15_000;

export interface SyncResult {
  registryVersion: string;
  /** Newly written manifests. */
  written: string[];
  /** Already present and unchanged, so left alone. */
  unchanged: string[];
  /** Present but different, and only replaced with `--force`. */
  conflicts: string[];
  skipped: SkippedAgent[];
  targetDir: string;
}

/** One bundled manifest, reduced to what the exclusion check needs. */
export interface BundledEntry {
  id: string;
  distribution: { type: string; package?: string; command?: string };
}

/**
 * The agents that ship with pew2, which a synced manifest must never shadow.
 *
 * Returns what each one launches as well as its id, because the registry names
 * several of them differently — `gemini` for our `gemini-cli`, `cursor` for our
 * `cursor-agent` — and matching on id alone would list those twice.
 */
export async function bundledEntries(
  dir: string = defaultProvidersDir(),
): Promise<BundledEntry[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((e) => e.endsWith(".json"));
  } catch {
    // No bundled directory is unusual but not fatal: it only means nothing is
    // protected from being shadowed.
    return [];
  }

  const entries: BundledEntry[] = [];
  for (const file of files) {
    try {
      const parsed = JSON.parse(await readFile(join(dir, file), "utf8")) as BundledEntry;
      if (parsed?.id && parsed.distribution) entries.push(parsed);
    } catch {
      // A manifest too broken to read is reported by `providers validate`; here
      // it just means one fewer id is protected.
    }
  }
  return entries;
}

/** Narrow enough that a test can supply one without restating `fetch`. */
export type Fetcher = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; statusText: string; json: () => Promise<unknown> }>;

export async function fetchRegistry(
  url: string = REGISTRY_URL,
  fetchImpl: Fetcher = fetch,
): Promise<unknown> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!response.ok) {
    throw new Error(`registry returned ${response.status} ${response.statusText}`);
  }
  return response.json();
}

/**
 * Write the converted manifests.
 *
 * An existing file is never silently overwritten. A user may have edited a
 * synced manifest — added an API key, changed the args — and losing that to a
 * routine refresh would be the kind of quiet data loss that stops people
 * running the command at all.
 */
export async function syncRegistry(options: {
  raw: unknown;
  targetDir?: string;
  bundled?: BundledEntry[];
  platform?: string;
  force?: boolean;
  dryRun?: boolean;
}): Promise<SyncResult> {
  const doc = parseRegistry(options.raw);
  const targetDir = options.targetDir ?? userProvidersDir();
  const bundled = options.bundled ?? (await bundledEntries());
  const platform = options.platform ?? platformKey();

  const { manifests, skipped } = toManifests(doc, bundled, platform);

  const written: string[] = [];
  const unchanged: string[] = [];
  const conflicts: string[] = [];

  if (!options.dryRun && manifests.length > 0) {
    await mkdir(targetDir, { recursive: true });
  }

  for (const manifest of manifests) {
    const path = join(targetDir, `${manifest.id}.json`);
    const body = serialise(manifest);
    const existing = await readIfPresent(path);

    if (existing === body) {
      unchanged.push(manifest.id);
      continue;
    }
    if (existing !== undefined && !options.force) {
      conflicts.push(manifest.id);
      continue;
    }
    if (!options.dryRun) await writeFile(path, body);
    written.push(manifest.id);
  }

  return {
    registryVersion: doc.version,
    written,
    unchanged,
    conflicts,
    skipped,
    targetDir,
  };
}

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Serialise stably.
 *
 * Byte-identical output for identical input is what lets a re-sync report
 * "unchanged" instead of "conflict", so the command is safe to run repeatedly.
 *
 * No `$schema` key: the bundled manifests use a repo-relative path that means
 * nothing from `~/.pew2/providers`, and a broken pointer in every synced file
 * would be worse than none.
 */
function serialise(manifest: ProviderManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}
