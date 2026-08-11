/**
 * Keeping the daemon alive across logins and crashes.
 *
 * Pairing is one-time, but the daemon is not: if it is not running, the phone
 * reaches nothing. Asking a user to re-run a command after every reboot defeats
 * the point of a remote control, so it is registered with the OS supervisor and
 * restarted automatically.
 *
 * All three platforms, each through its own supervisor: launchd here, systemd
 * in `service-systemd.ts`, Task Scheduler in `service-schtasks.ts`. This module
 * is the dispatcher and the macOS backend.
 *
 * Having one on every platform is what makes `update/apply.ts` work everywhere:
 * a self-update is a binary swap followed by an exit, and an exit is only an
 * update where something starts the process again.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { logDir } from "../logs.js";
import {
  LABEL,
  isCompiled,
  programArguments,
  run,
  serverEntry,
  type CommandResult,
  type InstallOptions,
  type RunCommand,
  type ServiceState,
  type ServiceStatus,
} from "./service-shared.js";
import {
  installSystemdUnit,
  systemdStatus,
  uninstallSystemdUnit,
  unitPath,
} from "./service-systemd.js";
import {
  installScheduledTask,
  scheduledTaskStatus,
  taskXmlPath,
  uninstallScheduledTask,
} from "./service-schtasks.js";

// Re-exported so the many existing importers of this module keep working, and
// so there is still one obvious place to import service types from.
export { LABEL, isCompiled, programArguments, serverEntry, unitPath, taskXmlPath };
export type { CommandResult, InstallOptions, ServiceState, ServiceStatus };

/**
 * Every platform pew2 ships a binary for now has a supervisor.
 *
 * Kept as a function because it is asked on the machine being installed to, not
 * at build time.
 */
export function isSupported(): boolean {
  return ["darwin", "linux", "win32"].includes(platform());
}

export function plistPath(home = homedir()): string {
  return join(home, "Library", "LaunchAgents", `${LABEL}.plist`);
}

/**
 * The file whose existence means "a supervisor was installed here".
 *
 * One question, three answers, and the self-updater asks it before deciding it
 * may end the process. Undefined for a platform with no backend, which is the
 * honest answer rather than a path that will never exist.
 */
export function supervisorPath(
  osPlatform: string = platform(),
  home = homedir(),
): string | undefined {
  if (osPlatform === "darwin") return plistPath(home);
  if (osPlatform === "linux") return unitPath(home);
  if (osPlatform === "win32") return taskXmlPath(home);
  return undefined;
}

/**
 * Is a supervisor actually installed on this machine?
 *
 * The platform is not enough, and assuming it was is a way to take a user's
 * daemon offline for good: `pew2 serve` is a first-class command, and a fresh
 * install has no service until `pew2 setup` creates one. On such a machine an
 * exit-to-update is simply an exit.
 *
 * Synchronous, because the update scheduler asks before arming anything.
 */
export function supervisorInstalled(
  osPlatform: string = platform(),
  home = homedir(),
): boolean {
  const path = supervisorPath(osPlatform, home);
  if (!path) return false;
  try {
    return existsSync(path);
  } catch {
    // An unreadable home is not a supervisor. Refusing costs a stale daemon;
    // guessing costs a dead one.
    return false;
  }
}

// Re-exported rather than redefined. The plist below and the daemon's own
// rotation must resolve to the identical path, or rotation trims one file while
// launchd goes on appending to another.
export { logDir };


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

/**
 * Keep `plistPath` populated alongside `servicePath`.
 *
 * `pew2 setup --json` and `doctor --json` are an agent-facing contract, and a
 * field that silently changed name would break whatever is parsing it. The new
 * platforms fill both; on macOS they are the same file.
 */
function withPlistAlias(status: ServiceStatus): ServiceStatus {
  return status.servicePath ? { ...status, plistPath: status.servicePath } : status;
}

export async function installService(options: InstallOptions = {}): Promise<ServiceStatus> {
  if (!isSupported()) {
    return { state: "unsupported", detail: `No service support for ${platform()} yet.` };
  }
  if (platform() === "linux") {
    return withPlistAlias(await installSystemdUnit(options, { runCommand: run }));
  }
  if (platform() === "win32") {
    return withPlistAlias(await installScheduledTask(options, { runCommand: run }));
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
      servicePath: path,
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
  if (platform() === "linux") {
    return withPlistAlias(await uninstallSystemdUnit(home, { runCommand: run }));
  }
  if (platform() === "win32") {
    return withPlistAlias(await uninstallScheduledTask(home, { runCommand: run }));
  }
  const path = plistPath(home);
  const domain = `gui/${process.getuid?.() ?? 501}`;
  await run("launchctl", ["bootout", `${domain}/${LABEL}`]);
  await rm(path, { force: true });
  return { state: "not-installed", plistPath: path, servicePath: path };
}

export async function serviceStatus(home = homedir()): Promise<ServiceStatus> {
  if (!isSupported()) {
    return { state: "unsupported", detail: `No service support for ${platform()} yet.` };
  }
  if (platform() === "linux") {
    return withPlistAlias(await systemdStatus(home, { runCommand: run }));
  }
  if (platform() === "win32") {
    return withPlistAlias(await scheduledTaskStatus(home, { runCommand: run }));
  }

  const path = plistPath(home);
  const logPath = join(logDir(), "daemon.log");

  let installed = true;
  try {
    await readFile(path, "utf8");
  } catch {
    installed = false;
  }
  if (!installed) return { state: "not-installed", plistPath: path, servicePath: path, logPath };

  const domain = `gui/${process.getuid?.() ?? 501}`;
  const printed = await run("launchctl", ["print", `${domain}/${LABEL}`]);
  if (printed.code !== 0) {
    return {
      state: "installed",
      plistPath: path,
      servicePath: path,
      logPath,
      detail: "Registered but not loaded.",
    };
  }

  const pid = printed.stdout.match(/\bpid = (\d+)/)?.[1];
  const lastExit = printed.stdout.match(/last exit code = (\d+)/)?.[1];

  return {
    state: pid ? "running" : "installed",
    plistPath: path,
    servicePath: path,
    logPath,
    pid: pid ? Number(pid) : undefined,
    lastExitCode: lastExit ? Number(lastExit) : undefined,
  };
}
