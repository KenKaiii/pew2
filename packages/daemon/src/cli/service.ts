/**
 * Keeping the daemon alive across logins and crashes.
 *
 * Pairing is one-time, but the daemon is not: if it is not running, the phone
 * reaches nothing. Asking a user to re-run a command after every reboot defeats
 * the point of a remote control, so it is registered with the OS supervisor and
 * restarted automatically.
 *
 * macOS launchd only for now. Linux gets a clear message rather than a broken
 * unit file.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { logDir } from "../logs.js";

export const LABEL = "dev.pew2.daemon";

export type ServiceState = "running" | "installed" | "not-installed" | "unsupported";

export interface ServiceStatus {
  state: ServiceState;
  /** Path of the launchd plist, when this platform has one. */
  plistPath?: string;
  /** PID when running. */
  pid?: number;
  /** Last exit code launchd saw. Non-zero after a crash. */
  lastExitCode?: number;
  logPath?: string;
  detail?: string;
}

export function isSupported(): boolean {
  return platform() === "darwin";
}

export function plistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

// Re-exported rather than redefined. The plist below and the daemon's own
// rotation must resolve to the identical path, or rotation trims one file while
// launchd goes on appending to another.
export { logDir };

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
 * launchd has no working directory and no shell, so every path in the plist has
 * to be absolute. Deriving it here means a moved or reinstalled checkout is
 * picked up by re-running `install` rather than silently pointing at a path that
 * no longer exists.
 *
 * Only meaningful for a source checkout. In a compiled binary this resolves to
 * `/$bunfs/server.ts` — a path inside the executable's virtual filesystem that
 * no other process can open, and which was being written into the plist as if
 * it were a real file. See `buildPlist`.
 */
export function serverEntry(): string {
  return resolve(fileURLToPath(new URL("../server.ts", import.meta.url)));
}

/**
 * What launchd should actually execute.
 *
 * Two different programs, because there are two ways pew2 is installed.
 *
 * From a checkout, `bun run <abs path to server.ts>` — the original arrangement,
 * and still correct there.
 *
 * From a compiled binary, the binary itself with `serve`. The old code took
 * `process.execPath` (the pew2 binary, not bun) and paired it with `run` and a
 * `/$bunfs/` path, producing `pew2 run /$bunfs/server.ts`: a subcommand that did
 * not exist, pointed at a file nothing outside the binary can read. pew2 printed
 * its help and exited 1, `KeepAlive` restarted it, and the result was a daemon
 * that crash-looped for ever while `pew2 setup` kept reporting it unreachable.
 * Every binary install has been in that state since binaries started shipping;
 * only people whose install predated them, running from source, had a daemon
 * that worked.
 */
export function programArguments(bunPath?: string): string[] {
  if (isCompiled()) return [process.execPath, "serve"];
  return [bunPath ?? process.execPath, "run", serverEntry()];
}

export interface CommandResult {
  code: number;
  stdout: string;
}

type RunCommand = (command: string, args: string[]) => Promise<CommandResult>;

function run(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stdout += chunk));
    // A missing binary must not throw; the caller reports it as a failed step.
    child.on("error", () => resolvePromise({ code: 127, stdout }));
    child.on("close", (code) => resolvePromise({ code: code ?? 1, stdout }));
  });
}

interface ReloadLaunchdJobOptions {
  domain: string;
  path: string;
  runCommand?: RunCommand;
  sleep?: (milliseconds: number) => Promise<void>;
}

/** Wait for an old launchd job to disappear, then load its replacement. */
export async function reloadLaunchdJob({
  domain,
  path,
  runCommand = run,
  sleep = (milliseconds) => new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds)),
}: ReloadLaunchdJobOptions): Promise<CommandResult> {
  // `bootout` returns before launchd has finished tearing the job down, and
  // bootstrapping into a domain that still holds the old one fails with a bare
  // "Input/output error". Wait for it to actually disappear.
  for (let i = 0; i < 25; i++) {
    const printed = await runCommand("launchctl", ["print", `${domain}/${LABEL}`]);
    if (printed.code !== 0) break;
    await sleep(200);
  }

  // The old job can still be in flight after `print` stops finding it.
  let boot = await runCommand("launchctl", ["bootstrap", domain, path]);
  for (let i = 0; i < 5 && boot.code !== 0; i++) {
    await sleep(400);
    boot = await runCommand("launchctl", ["bootstrap", domain, path]);
  }
  return boot;
}

export interface InstallOptions {
  /** Absolute path to the `bun` binary. launchd has no PATH of its own. */
  bunPath?: string;
  port?: number;
  /** Surface test fixtures such as the echo agent. */
  experimental?: boolean;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

export function buildPlist(options: InstallOptions = {}): string {
  const program = programArguments(options.bunPath);
  // The directory the runtime lives in is prepended to PATH below. For a source
  // install that is bun's own directory, which is what makes `npx` reachable;
  // for a binary it is wherever pew2 was installed, which is harmless.
  const bun = options.bunPath ?? process.execPath;
  const logs = logDir(options.env);
  const port = options.port ?? Number(options.env?.PEW2_PORT ?? 8787);

  // launchd starts processes with a near-empty environment, so anything the
  // daemon needs has to be stated explicitly. PATH in particular: without it
  // `npx`-based providers cannot be spawned and every agent appears missing.
  const path = options.env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin";
  const entries: [string, string][] = [
    ["PATH", `${dirname(bun)}:${path}`],
    ["PEW2_PORT", String(port)],
    ["HOME", options.home ?? homedir()],
  ];
  if (options.experimental) entries.push(["PEW2_EXPERIMENTAL", "1"]);
  if (options.env?.PEW2_HOME) entries.push(["PEW2_HOME", options.env.PEW2_HOME]);
  if (options.env?.PEW2_RELAY) entries.push(["PEW2_RELAY", options.env.PEW2_RELAY]);

  const envXml = entries
    .map(([key, value]) => `      <key>${key}</key>\n      <string>${escapeXml(value)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${LABEL}</string>

    <key>ProgramArguments</key>
    <array>
${program.map((part) => `      <string>${escapeXml(part)}</string>`).join("\n")}
    </array>

    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>

    <key>RunAtLoad</key>
    <true/>

    <!-- Restart if the daemon exits for any reason. A crashed daemon is a phone
         that silently stops working, with nobody at the machine to notice. -->
    <key>KeepAlive</key>
    <true/>

    <!-- launchd throttles restarts to once per 10s by default and logs a
         complaint; 10 is the floor it accepts without one. -->
    <key>ThrottleInterval</key>
    <integer>10</integer>

    <key>StandardOutPath</key>
    <string>${escapeXml(join(logs, "daemon.log"))}</string>
    <key>StandardErrorPath</key>
    <string>${escapeXml(join(logs, "daemon.error.log"))}</string>
  </dict>
</plist>
`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export async function installService(options: InstallOptions = {}): Promise<ServiceStatus> {
  if (!isSupported()) {
    return { state: "unsupported", detail: `No service support for ${platform()} yet.` };
  }

  const home = options.home ?? homedir();
  const path = plistPath(home);
  await mkdir(dirname(path), { recursive: true });
  await mkdir(logDir(options.env), { recursive: true });
  await writeFile(path, buildPlist(options), "utf8");

  const domain = `gui/${process.getuid?.() ?? 501}`;

  // Unload first so re-running install picks up a changed plist. `bootout` on a
  // service that is not loaded returns non-zero, which is expected and ignored.
  await run("launchctl", ["bootout", `${domain}/${LABEL}`]);

  const boot = await reloadLaunchdJob({ domain, path });

  if (boot.code !== 0) {
    return {
      state: "installed",
      plistPath: path,
      detail: `Written, but launchctl bootstrap failed: ${boot.stdout.trim() || `exit ${boot.code}`}`,
    };
  }

  // launchd reports the job before the process has been spawned, so a status
  // read here can race and report "installed" for a service that is starting.
  for (let i = 0; i < 15; i++) {
    const status = await serviceStatus(home);
    if (status.state === "running") return status;
    await new Promise((r) => setTimeout(r, 200));
  }

  return serviceStatus(home);
}

export async function uninstallService(home = homedir()): Promise<ServiceStatus> {
  if (!isSupported()) {
    return { state: "unsupported", detail: `No service support for ${platform()} yet.` };
  }
  const path = plistPath(home);
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await run("launchctl", ["bootout", `${domain}/${LABEL}`]);
  await rm(path, { force: true });
  return { state: "not-installed", plistPath: path };
}

export async function serviceStatus(home = homedir()): Promise<ServiceStatus> {
  if (!isSupported()) {
    return { state: "unsupported", detail: `No service support for ${platform()} yet.` };
  }

  const path = plistPath(home);
  const logPath = join(logDir(), "daemon.log");

  let installed = true;
  try {
    await readFile(path, "utf8");
  } catch {
    installed = false;
  }
  if (!installed) return { state: "not-installed", plistPath: path, logPath };

  const domain = `gui/${process.getuid?.() ?? 501}`;
  const printed = await run("launchctl", ["print", `${domain}/${LABEL}`]);
  if (printed.code !== 0) {
    return { state: "installed", plistPath: path, logPath, detail: "Registered but not loaded." };
  }

  const pid = printed.stdout.match(/\bpid = (\d+)/)?.[1];
  const lastExit = printed.stdout.match(/last exit code = (\d+)/)?.[1];

  return {
    state: pid ? "running" : "installed",
    plistPath: path,
    logPath,
    pid: pid ? Number(pid) : undefined,
    lastExitCode: lastExit ? Number(lastExit) : undefined,
  };
}
