/**
 * The projects a client has actually opened, remembered across restarts.
 *
 * `cwd` is only ever accepted from a client when this daemon published the
 * string first — as a project with agent history, or as a directory just
 * offered while browsing. The browse half of that lived in memory alone, on the
 * assumption that a path is chosen within seconds of being shown. It is not: the
 * app keeps the chosen project and re-sends it on every reconnect, every new
 * conversation and every `workspace.status` for as long as that project is
 * selected — which outlives the daemon process by days.
 *
 * So a project reached by browsing stopped being recognised the moment the
 * daemon restarted, and the failure was silent and confident: `workspace.status`
 * answered with the agent's *previous* project, so the composer named a
 * directory the user had not chosen, and starting there was then refused as an
 * unknown project. From the phone that reads as "the new chat is stuck on the
 * last repo, whatever I pick".
 *
 * Written on acceptance rather than on offer: browsing a directory lists
 * everything in it, and none of those paths need to be durable — only the one
 * the user went on to use. That keeps this file a short record of chosen
 * projects rather than a map of the disk.
 */
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { userProvidersDir } from "./providers/registry.js";
import { writeFileAtomic } from "./atomic-file.js";

/**
 * How many are kept, oldest dropped first.
 *
 * Generous next to the number of repos anyone opens from a phone, and still a
 * bound: this is read on the first path check after boot, so it must stay a file
 * that parses in microseconds.
 */
export const KNOWN_PROJECT_LIMIT = 200;

function knownProjectsPath(env: NodeJS.ProcessEnv): string {
  return join(dirname(userProvidersDir(env)), "known-projects.json");
}

/**
 * Chosen projects, oldest first.
 *
 * Missing or corrupt reads as "none", never as an error: this file is a
 * convenience for recognising a path, and failing to read it must not stop a
 * session starting.
 */
export async function readKnownProjects(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(knownProjectsPath(env), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((path): path is string => typeof path === "string")
      .slice(-KNOWN_PROJECT_LIMIT);
  } catch {
    return [];
  }
}

/**
 * Add one project to the stored set.
 *
 * Read-modify-write of the whole file, so a second daemon — a development one
 * beside the installed one, or an update restarting under a running app — adds
 * to the list instead of replacing it with its own.
 *
 * @returns The stored set after the write, oldest first.
 */
export async function rememberKnownProject(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const path = knownProjectsPath(env);
  const stored = (await readKnownProjects(env)).filter((known) => known !== cwd);
  // Newest last, so the cap above drops the project nobody has opened in
  // longest rather than the one just chosen.
  const next = [...stored, cwd].slice(-KNOWN_PROJECT_LIMIT);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFileAtomic(path, JSON.stringify(next, null, 2));
  return next;
}
