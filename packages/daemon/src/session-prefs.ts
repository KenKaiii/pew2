/**
 * The selectors a user chose *for one conversation*.
 *
 * `config-prefs.json` remembers the last choice per provider, which is what a
 * brand new session should open with. It is the wrong answer for reopening an
 * existing one: ACP's `session/load` hands back the agent's own defaults rather
 * than the model the conversation was last held at, so leaving a resumed
 * session alone silently reverts it ("I picked Sonnet, switched away, came back
 * on Opus"), while blindly applying the provider preference would rewrite a
 * conversation started at the desk to match whatever the phone last picked.
 *
 * So the daemon records the selectors per agent session id and replays exactly
 * those on load. A conversation it has never seen configured keeps whatever the
 * agent reports — that one is genuinely the agent's business.
 *
 * Kept in its own file: `config-prefs.json` is a small hand-editable map of
 * provider defaults, and this grows an entry per conversation.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userProvidersDir } from "./providers/registry.js";
import type { ConfigPrefs } from "./config-prefs.js";

/** Newest conversations kept; older records are dropped on write. */
const MAX_SESSIONS = 300;

interface SessionRecord {
  prefs: ConfigPrefs;
  /** Epoch ms, used only to decide what to evict. */
  updatedAt: number;
}

type Stored = Record<string, SessionRecord>;

function prefsPath(env: NodeJS.ProcessEnv): string {
  return join(dirname(userProvidersDir(env)), "session-prefs.json");
}

/** Provider *and* session: agents pick their own ids and could collide. */
function key(providerId: string, agentSessionId: string): string {
  return `${providerId}:${agentSessionId}`;
}

async function readAll(env: NodeJS.ProcessEnv): Promise<Stored> {
  try {
    const parsed = JSON.parse(await readFile(prefsPath(env), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Stored) : {};
  } catch {
    // Missing or corrupt is a miss, never an error: this is a convenience and
    // failing to read it must not stop a conversation reopening.
    return {};
  }
}

export async function readSessionPrefs(
  providerId: string,
  agentSessionId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigPrefs> {
  const record = (await readAll(env))[key(providerId, agentSessionId)];
  return record?.prefs && typeof record.prefs === "object" ? record.prefs : {};
}

/**
 * Merge choices into one conversation's record.
 *
 * Read-modify-write of the whole file, like `config-prefs.json`: every session
 * shares it, and picking a mode must not forget the model.
 */
export async function writeSessionPrefs(
  providerId: string,
  agentSessionId: string,
  prefs: ConfigPrefs,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (Object.keys(prefs).length === 0) return;
  const path = prefsPath(env);
  const all = await readAll(env);
  const id = key(providerId, agentSessionId);
  all[id] = {
    prefs: { ...all[id]?.prefs, ...prefs },
    updatedAt: Date.now(),
  };

  // Bounded, so a machine with thousands of conversations does not grow a file
  // the daemon reads on every session open.
  const entries = Object.entries(all);
  const kept =
    entries.length > MAX_SESSIONS
      ? entries
          .sort((a, b) => (b[1]?.updatedAt ?? 0) - (a[1]?.updatedAt ?? 0))
          .slice(0, MAX_SESSIONS)
      : entries;

  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(Object.fromEntries(kept), null, 2), "utf8");
}
