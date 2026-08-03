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
import { SESSION_HISTORY_LIMIT } from "./session-history.js";
import type { AgentSession } from "./acp/connect.js";
import type { ProviderCapabilities } from "./index.js";

export interface CachedProbe extends ProviderCapabilities {
  /** Epoch ms, so callers can decide when a background refresh is due. */
  probedAt: number;
  /**
   * The uncapped session list, so a project chosen straight after a daemon
   * restart can be listed from disk instead of waiting on a fresh probe.
   * Stored without message counts: those are read per project, on demand.
   */
  allSessions?: AgentSession[];
}

/**
 * Ceiling on that list. A year of daily conversations is a few hundred rows of
 * ~150 bytes; capping keeps a pathological history from turning the cache into
 * a megabyte the daemon parses on every boot.
 */
const CACHED_HISTORY_LIMIT = 500;

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
    return {
      ...(parsed as CachedProbe),
      // Old cache files may predate the UI limit; never briefly republish all
      // 600 rows while their background refresh runs.
      sessions: parsed.sessions.slice(0, SESSION_HISTORY_LIMIT),
      allSessions: Array.isArray(parsed.allSessions) ? parsed.allSessions : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Persist a successful probe. Best-effort: a cache miss next time, never an error. */
export async function writeProbeCache(
  providerId: string,
  capabilities: ProviderCapabilities,
  env: NodeJS.ProcessEnv = process.env,
  allSessions: AgentSession[] = [],
): Promise<void> {
  const path = cachePath(providerId, env);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    JSON.stringify({
      ...capabilities,
      sessions: capabilities.sessions.slice(0, SESSION_HISTORY_LIMIT),
      // Trimmed to what the project menu needs: identity, project, date. The
      // count is deliberately dropped, since it is only ever read for the one
      // project the user picks.
      //
      // Omitted entirely when there is nothing to store, so "this agent has no
      // history" and "this file predates the field" stay the same absent value
      // rather than one of them reading as an answer.
      allSessions: allSessions.length
        ? allSessions
            .slice(0, CACHED_HISTORY_LIMIT)
            .map(({ sessionId, cwd, title, updatedAt }) => ({ sessionId, cwd, title, updatedAt }))
        : undefined,
      probedAt: Date.now(),
    }),
  );
}
