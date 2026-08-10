/**
 * Which agents this machine actually offers.
 *
 * `pew2 setup` writes a manifest for every agent it finds on PATH, which is the
 * right default — it means a working setup with nothing to configure. But every
 * agent in that list then gets spawned: the app asks each one what it supports
 * as soon as it connects, and each answer costs a real process. An agent that
 * happens to be installed but is never used still boots, still holds memory,
 * and still appears in the drawer as something to scroll past.
 *
 * So agents can be turned off. A disabled agent is not announced to the phone,
 * not probed, and never spawned; its manifest stays on disk, so turning it back
 * on is instant and loses nothing.
 *
 * Stored as a list of the agents that are OFF rather than the ones that are ON.
 * That way installing a new agent makes it available without anyone having to
 * remember to add it, which is the behaviour people expect from a tool that
 * detects things for them.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userProvidersDir } from "./registry.js";

/**
 * Shape of `disabled.json`, versioned so the format can move later.
 *
 * **Version 2 is not a format change — it is a trust change.** A version 1 file
 * cannot be read as a record of anything the user decided.
 *
 * Setup used to make an agent unselectable in the picker whenever it failed
 * verification, and then wrote every unselected row to this file. So an agent
 * that was merely not signed into, or whose check timed out on a slow first
 * `npx` download, was recorded as "the user turned this off" — by us, on their
 * behalf, with nothing on screen saying so. Signing in afterwards changed
 * nothing: the agent stayed off, and the only way back was a command they had
 * no reason to know existed.
 *
 * Nothing in the file distinguishes those from a genuine choice, because both
 * are just an id in a list. So version 1 is not migrated — it is retired: the
 * old list is kept as a backup and the new file starts empty, which puts every
 * agent back in the picker exactly once so the user can say what they meant.
 *
 * Wrong in the recoverable direction. An agent wrongly left ON is visible, and
 * one tap turns it off; an agent wrongly left OFF is invisible, which is the bug
 * being undone.
 */
const VERSION = 2;

interface DisabledFile {
  version: number;
  /** Provider ids the user has turned off. */
  disabled: string[];
}

function disabledPath(env: NodeJS.ProcessEnv): string {
  return join(dirname(userProvidersDir(env)), "disabled.json");
}

/** Where a retired version 1 list is kept, in case someone wants to look. */
function backupPath(env: NodeJS.ProcessEnv): string {
  return `${disabledPath(env)}.v1.bak`;
}

function parseFile(text: string): DisabledFile | undefined {
  const raw: unknown = JSON.parse(text);
  const parsed = raw as Partial<DisabledFile>;
  if (typeof parsed.version !== "number" || !Array.isArray(parsed.disabled)) return undefined;
  return {
    version: parsed.version,
    disabled: parsed.disabled.filter((id): id is string => typeof id === "string"),
  };
}

/**
 * The agents currently turned off. Empty when the file is missing.
 *
 * A version 1 file reads as empty for the reason above: its contents are not
 * known to be choices. `retireLegacyDisabled` turns that into a one-time,
 * visible event; until it runs, reading as empty is the safe direction — the
 * agent stays visible rather than silently missing.
 */
export async function readDisabled(env: NodeJS.ProcessEnv = process.env): Promise<Set<string>> {
  try {
    const parsed = parseFile(await readFile(disabledPath(env), "utf8"));
    if (!parsed || parsed.version !== VERSION) return new Set();
    return new Set(parsed.disabled);
  } catch {
    // Missing, unreadable or half-written. Everything installed is on, which is
    // the safe direction to fail: an agent the user wanted stays visible.
    return new Set();
  }
}

/**
 * Retire a version 1 list, once.
 *
 * Returns the ids that were turned back on, so the caller can say so out loud —
 * a setting that changes itself without telling anyone is how this started.
 * Empty when there was nothing to do, which is every run after the first.
 */
export async function retireLegacyDisabled(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const path = disabledPath(env);
  let parsed: DisabledFile | undefined;
  try {
    parsed = parseFile(await readFile(path, "utf8"));
  } catch {
    return [];
  }
  if (!parsed || parsed.version >= VERSION) return [];

  // Kept rather than deleted: this is the only record of what was in the list,
  // and the whole reason for the migration is that we cannot be sure how much
  // of it the user meant.
  await rename(path, backupPath(env));
  await writeDisabled([], env);
  return [...parsed.disabled].sort();
}

/** Replace the set of disabled agents. */
export async function writeDisabled(
  disabled: Iterable<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = disabledPath(env);
  const body: DisabledFile = { version: VERSION, disabled: [...new Set(disabled)].sort() };
  await mkdir(dirname(path), { recursive: true });
  // Written beside and renamed, so a daemon reading this file mid-write sees
  // either the old list or the new one, never a truncated one.
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  await rename(temp, path);
}

/**
 * Turn agents on or off.
 *
 * Returns the new set so a caller can report what changed without re-reading.
 */
export async function setEnabled(
  ids: Iterable<string>,
  enabled: boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<Set<string>> {
  // Before reading, or a legacy list would be silently discarded by the write
  // below rather than backed up — `pew2 providers disable x` must not be the
  // thing that quietly drops the old file.
  await retireLegacyDisabled(env);
  const disabled = await readDisabled(env);
  for (const id of ids) {
    if (enabled) disabled.delete(id);
    else disabled.add(id);
  }
  await writeDisabled(disabled, env);
  return disabled;
}
