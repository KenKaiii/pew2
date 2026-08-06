/**
 * The selectors a user last chose, per provider.
 *
 * Model and mode are properties of a *session*, so ACP gives every new one the
 * agent's own default. That is the right protocol behaviour and the wrong
 * product behaviour: picking Opus, then starting the next conversation, must
 * not silently drop you back to the default. The daemon remembers the choice
 * and re-applies it, because it is the one place every client and both
 * transports already share — remembering it on the phone would leave a session
 * started from the desktop with different settings.
 *
 * Kept out of the probe cache deliberately: that file is the agent's answer and
 * is overwritten wholesale by the next probe, while this is the user's.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userProvidersDir } from "./providers/registry.js";
import { writeFileAtomic } from "./atomic-file.js";

/** Config id to chosen value, for one provider. */
export type ConfigPrefs = Record<string, string | boolean>;

function prefsPath(env: NodeJS.ProcessEnv): string {
  return join(dirname(userProvidersDir(env)), "config-prefs.json");
}

type Stored = Record<string, ConfigPrefs>;

async function readAll(env: NodeJS.ProcessEnv): Promise<Stored> {
  try {
    const parsed = JSON.parse(await readFile(prefsPath(env), "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as Stored) : {};
  } catch {
    // Missing or corrupt is a miss, never an error: a preference file is a
    // convenience, and failing to read one must not stop a session starting.
    return {};
  }
}

export async function readConfigPrefs(
  providerId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ConfigPrefs> {
  return (await readAll(env))[providerId] ?? {};
}

/**
 * Merge one choice into the stored set.
 *
 * Read-modify-write of the whole file, since every provider shares it and a
 * blind overwrite would drop the others — which is why the write itself has to
 * be atomic. A truncated file reads as "nothing was ever chosen", so a crash at
 * the wrong moment loses every provider's settings rather than one.
 */
export async function writeConfigPref(
  providerId: string,
  configId: string,
  value: string | boolean,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = prefsPath(env);
  const all = await readAll(env);
  all[providerId] = { ...all[providerId], [configId]: value };
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, JSON.stringify(all, null, 2));
}
