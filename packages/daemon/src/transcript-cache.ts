/**
 * A local copy of what a conversation looked like, so reopening it is instant.
 *
 * Claude Code and ggcoder keep their own transcripts on disk, and the daemon
 * reads those directly — which is why reopening one of their conversations
 * paints in about 30ms even when the agent process has to be spawned from
 * scratch. Every other agent has no such file, so the app showed an empty
 * thread for the two to three seconds the spawn took, and only then replayed.
 * Measured on GitHub Copilot: 3188ms of nothing versus Claude Code's 28ms.
 *
 * This gives every other agent the same thing. The first time a conversation is
 * opened it still costs the spawn, and what came back is written here; every
 * open after that paints from disk while the agent reconnects behind it.
 *
 * Worth being explicit, because it is conversation content at rest: this writes
 * message text into `~/.pew2/cache/transcripts`. That is the same machine, the
 * same user and the same directory the agents already write their own history
 * to, and nothing here leaves the machine. Deleting the directory costs a
 * slower first open and nothing else.
 */
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userProvidersDir } from "./providers/registry.js";

/** One replayed update, stored exactly as the agent sent it. */
export interface CachedTranscript {
  /** Bumped when the shape changes, so an old file is ignored not misread. */
  version: 1;
  providerId: string;
  agentSessionId: string;
  updatedAt: string;
  updates: unknown[];
}

/**
 * Ceiling on a stored transcript.
 *
 * A long conversation is worth painting instantly, but not at the cost of the
 * daemon parsing megabytes on a tap. The most recent updates are the ones on
 * screen, so an over-long transcript keeps its tail.
 */
const MAX_UPDATES = 400;

/**
 * How many conversations keep a cached transcript per agent.
 *
 * Each file is capped, but the number of files was not: one per conversation,
 * kept forever, on a machine where someone opens a few every day. The oldest
 * are dropped, since the cache only ever saves time on a conversation being
 * reopened and the recent ones are the ones that get reopened.
 */
const MAX_TRANSCRIPTS_PER_PROVIDER = 200;

function transcriptPath(
  providerId: string,
  agentSessionId: string,
  env: NodeJS.ProcessEnv,
): string {
  // Only the agent's id needs scrubbing. `providerId` is checked against
  // `^[a-z][a-z0-9-]*$` when the manifest loads, so it cannot hold a separator;
  // session ids come from the agent and routinely do.
  //
  // Scrubbing can map two ids onto one filename, which is why `readTranscript`
  // checks the stored id before trusting what it read.
  const safe = agentSessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 120);
  return join(dirname(userProvidersDir(env)), "cache", "transcripts", providerId, `${safe}.json`);
}

/** The stored transcript for a conversation, or undefined when there is none. */
export async function readTranscript(
  providerId: string,
  agentSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<unknown[] | undefined> {
  try {
    const raw: unknown = JSON.parse(
      await readFile(transcriptPath(providerId, agentSessionId, env), "utf8"),
    );
    const parsed = raw as Partial<CachedTranscript>;
    if (parsed.version !== 1 || !Array.isArray(parsed.updates)) return undefined;
    // Belt and braces: a cache written for one conversation must never paint
    // another. A mismatch means the file was moved or hand-edited.
    if (parsed.agentSessionId !== agentSessionId) return undefined;
    return parsed.updates.length > 0 ? parsed.updates : undefined;
  } catch {
    // No cache, unreadable, or half-written. All mean "open it the slow way".
    return undefined;
  }
}

/** Store what an agent replayed, for the next time this conversation opens. */
export async function writeTranscript(
  providerId: string,
  agentSessionId: string,
  updates: unknown[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (updates.length === 0) return;
  const path = transcriptPath(providerId, agentSessionId, env);
  const body: CachedTranscript = {
    version: 1,
    providerId,
    agentSessionId,
    updatedAt: new Date().toISOString(),
    updates: updates.slice(-MAX_UPDATES),
  };
  try {
    await mkdir(dirname(path), { recursive: true });
    // Written beside and renamed: a daemon killed mid-write would otherwise
    // leave a truncated file that reads as a real but corrupt transcript.
    const temp = `${path}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify(body), "utf8");
    await rename(temp, path);
    await prune(dirname(path));
  } catch {
    // Best effort. A cache that cannot be written costs a slow open, and the
    // conversation itself is unaffected.
  }
}

/** Drop the oldest transcripts once a provider has too many. */
async function prune(dir: string): Promise<void> {
  try {
    const names = (await readdir(dir)).filter((name) => name.endsWith(".json"));
    if (names.length <= MAX_TRANSCRIPTS_PER_PROVIDER) return;

    const withTimes = await Promise.all(
      names.map(async (name) => {
        const full = join(dir, name);
        try {
          return { full, at: (await stat(full)).mtimeMs };
        } catch {
          // Vanished between the listing and the stat.
          return undefined;
        }
      }),
    );

    const sorted = withTimes
      .filter((entry): entry is { full: string; at: number } => entry !== undefined)
      .sort((a, b) => a.at - b.at);

    for (const entry of sorted.slice(0, sorted.length - MAX_TRANSCRIPTS_PER_PROVIDER)) {
      await rm(entry.full, { force: true });
    }
  } catch {
    // A cache that cannot be pruned is a disk-space question, not a correctness
    // one. The conversation is unaffected either way.
  }
}
