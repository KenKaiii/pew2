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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

function transcriptPath(
  providerId: string,
  agentSessionId: string,
  env: NodeJS.ProcessEnv,
): string {
  // The agent's id goes in the filename, so anything that is not plainly safe
  // in a path is replaced rather than trusted.
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
    const { rename } = await import("node:fs/promises");
    await rename(temp, path);
  } catch {
    // Best effort. A cache that cannot be written costs a slow open, and the
    // conversation itself is unaffected.
  }
}

/** Forget a conversation's cached transcript. */
export async function forgetTranscript(
  providerId: string,
  agentSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  try {
    await rm(transcriptPath(providerId, agentSessionId, env), { force: true });
  } catch {
    // Nothing to forget.
  }
}
