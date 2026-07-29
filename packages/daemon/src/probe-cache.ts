/**
 * On-disk cache of provider probes.
 *
 * A probe costs one agent spawn plus a `session/list` — seconds per provider,
 * and GG Coder is the slow end of that. Paying it on every drawer open makes
 * the phone feel broken, so the last good answer is served from disk instantly
 * and refreshed in the background (stale-while-revalidate).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userProvidersDir } from "./providers/registry.js";
import type { ProviderCapabilities } from "./index.js";

export interface CachedProbe extends ProviderCapabilities {
  /** Epoch ms, so callers can decide when a background refresh is due. */
  probedAt: number;
}

function cachePath(providerId: string, env: NodeJS.ProcessEnv): string {
  return join(dirname(userProvidersDir(env)), "cache", `${providerId}.json`);
}

/** The last good probe for a provider, or undefined when none is usable. */
export async function readProbeCache(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CachedProbe | undefined> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(providerId, env), "utf8"));
    if (
      typeof parsed?.probedAt !== "number" ||
      !Array.isArray(parsed?.sessions) ||
      !Array.isArray(parsed?.configOptions)
    ) {
      return undefined;
    }
    return parsed as CachedProbe;
  } catch {
    return undefined;
  }
}

/** Persist a successful probe. Best-effort: a cache miss next time, never an error. */
export async function writeProbeCache(
  providerId: string,
  capabilities: ProviderCapabilities,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = cachePath(providerId, env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ ...capabilities, probedAt: Date.now() }));
}
