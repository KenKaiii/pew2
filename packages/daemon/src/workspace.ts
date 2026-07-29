/**
 * Where an agent process runs when nobody asked for a directory.
 *
 * Under launchd the daemon starts with cwd `/`, and an agent that treats its
 * cwd as a project root then writes straight into the filesystem root — GG
 * Coder failed exactly this way, `mkdir '/.gg'`, and its session history never
 * reached the phone. A headless daemon has no meaningful cwd of its own, so the
 * home directory is the honest default: it is where a terminal would have put
 * the agent, and it is always writable by the user the daemon runs as.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { parse } from "node:path";

/**
 * Resolve the working directory for a spawned agent.
 *
 * Order: an explicit request from the client, then `PEW2_WORKSPACE`, then the
 * daemon's own cwd when it is a real directory, and finally the user's home.
 */
export function resolveWorkspace(
  requested?: string,
  env: NodeJS.ProcessEnv = process.env,
  daemonCwd: string = process.cwd(),
  home: string = homedir(),
): string {
  const explicit = requested ?? env.PEW2_WORKSPACE;
  if (explicit) return explicit;

  // A filesystem root is never a sane project directory. It is exactly what
  // launchd hands the daemon, and spawning an agent there writes its state
  // into `/` or fails trying.
  if (daemonCwd !== parse(daemonCwd).root && existsSync(daemonCwd)) return daemonCwd;
  return home;
}
