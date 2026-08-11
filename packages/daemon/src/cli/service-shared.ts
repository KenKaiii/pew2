/**
 * What the three supervisor backends agree on.
 *
 * launchd, systemd and Task Scheduler each get their own module, because the
 * details do not generalise — a plist, a unit file and a task XML have nothing
 * in common but intent. This is the part that genuinely is shared: the label,
 * the result shape, and the two questions every backend has to answer the same
 * way ("what program should be run" and "is this a compiled binary").
 *
 * Separate from `service.ts` so the backends can import it without importing
 * each other through their dispatcher.
 */
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

/** One name across all three supervisors, so a machine cannot host two. */
export const LABEL = "dev.pew2.daemon";

export type ServiceState = "running" | "installed" | "not-installed" | "unsupported";

export interface ServiceStatus {
  state: ServiceState;
  /**
   * The file that defines the service: a launchd plist, a systemd unit, or the
   * task XML on Windows. Its presence is what `supervisorInstalled()` reads.
   */
  servicePath?: string;
  /** Kept as an alias so existing callers and JSON output do not change shape. */
  plistPath?: string;
  /** PID when running. */
  pid?: number;
  /** Last exit code the supervisor saw. Non-zero after a crash. */
  lastExitCode?: number;
  logPath?: string;
  detail?: string;
}

export interface InstallOptions {
  /** Absolute path to the `bun` binary. A supervisor has no PATH of its own. */
  bunPath?: string;
  port?: number;
  /** Surface test fixtures such as the echo agent. */
  experimental?: boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
}

export type RunCommand = (command: string, args: string[]) => Promise<CommandResult>;

/**
 * Is this a compiled binary rather than a source checkout?
 *
 * Bun serves a compiled binary's own modules out of a virtual filesystem rooted
 * at `/$bunfs/`, so `import.meta.url` says so directly. Everything downstream of
 * this question was wrong before it was asked.
 */
export function isCompiled(): boolean {
  return import.meta.url.includes("/$bunfs/");
}

/**
 * The daemon entry point, resolved from this file.
 *
 * A supervisor has no working directory and no shell, so every path has to be
 * absolute. Only meaningful for a source checkout: in a compiled binary this
 * resolves to a path inside the executable's own virtual filesystem, which no
 * other process can open.
 */
export function serverEntry(): string {
  return resolve(fileURLToPath(new URL("../server.ts", import.meta.url)));
}

/**
 * What the supervisor should actually execute.
 *
 * Two different programs, because there are two ways pew2 is installed: from a
 * checkout it is `bun run <abs path to server.ts>`, and from a released binary
 * it is the binary itself with `serve`.
 */
export function programArguments(bunPath?: string): string[] {
  if (isCompiled()) return [process.execPath, "serve"];
  return [bunPath ?? process.execPath, "run", serverEntry()];
}

/** Run a command, treating a missing binary as a failed step rather than a throw. */
export function run(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stdout += chunk));
    child.on("error", () => resolvePromise({ code: 127, stdout }));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout }));
  });
}
