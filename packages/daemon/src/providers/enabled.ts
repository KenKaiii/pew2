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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userProvidersDir } from "./registry.js";

/** Shape of `disabled.json`, versioned so the format can move later. */
interface DisabledFile {
  version: 1;
  /** Provider ids the user has turned off. */
  disabled: string[];
}

function disabledPath(env: NodeJS.ProcessEnv): string {
  return join(dirname(userProvidersDir(env)), "disabled.json");
}

/** The agents currently turned off. Empty when the file is missing. */
export async function readDisabled(env: NodeJS.ProcessEnv = process.env): Promise<Set<string>> {
  try {
    const raw: unknown = JSON.parse(await readFile(disabledPath(env), "utf8"));
    const parsed = raw as Partial<DisabledFile>;
    if (parsed.version !== 1 || !Array.isArray(parsed.disabled)) return new Set();
    return new Set(parsed.disabled.filter((id): id is string => typeof id === "string"));
  } catch {
    // Missing, unreadable or half-written. Everything installed is on, which is
    // the safe direction to fail: an agent the user wanted stays visible.
    return new Set();
  }
}

/** Replace the set of disabled agents. */
export async function writeDisabled(
  disabled: Iterable<string>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = disabledPath(env);
  const body: DisabledFile = { version: 1, disabled: [...new Set(disabled)].sort() };
  await mkdir(dirname(path), { recursive: true });
  // Written beside and renamed, so a daemon reading this file mid-write sees
  // either the old list or the new one, never a truncated one.
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(body, null, 2)}\n`, "utf8");
  const { rename } = await import("node:fs/promises");
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
  const disabled = await readDisabled(env);
  for (const id of ids) {
    if (enabled) disabled.delete(id);
    else disabled.add(id);
  }
  await writeDisabled(disabled, env);
  return disabled;
}
