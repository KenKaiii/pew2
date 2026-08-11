/**
 * Keeping the daemon alive on Linux, via a systemd **user** unit.
 *
 * The launchd half of this lives in `service.ts`; this is the same idea in the
 * other dialect. A user unit rather than a system one because pew2 spawns coding
 * agents as the person using it: their `$HOME`, their ssh keys, their npm cache.
 * A root unit would run every agent as root, and nothing about a phone remote
 * needs that.
 *
 * `Restart=always` is the exact counterpart of launchd's `KeepAlive`, and the
 * distinction matters more than it looks: `on-failure` — the setting most guides
 * recommend — does **not** restart a process that exited zero, which is
 * precisely how the self-updater ends the daemon. Under `on-failure` an update
 * would swap the binary, exit cleanly, and leave the user's phone offline for
 * good. `always` restarts regardless of exit reason.
 *
 * The one thing a user unit needs that a system unit does not is *lingering*:
 * without `loginctl enable-linger`, systemd tears the whole user manager down at
 * logout and the daemon dies with it. That is a real difference from macOS, and
 * it is why `enable-linger` is attempted at install and reported when refused.
 */
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";
import { logDir } from "../logs.js";
import {
  LABEL,
  programArguments,
  type CommandResult,
  type InstallOptions,
  type ServiceStatus,
} from "./service-shared.js";

/** systemd wants a `.service` suffix; the label is otherwise the launchd one. */
export const UNIT_NAME = `${LABEL}.service`;

/** Where a user unit lives. `systemctl --user` reads this without any root. */
export function unitPath(home = homedir()): string {
  return join(home, ".config", "systemd", "user", UNIT_NAME);
}

/**
 * Quote a value for `Environment=`.
 *
 * Two hazards, both silent. A value containing spaces splits into several
 * assignments unless the whole `KEY=value` is quoted — which is how a `PATH`
 * with a space in it turns into a daemon that cannot find `npx`. And `%` is
 * systemd's specifier prefix, so an unescaped one is expanded into something
 * else entirely; `%%` is the literal.
 */
function environmentLine(key: string, value: string): string {
  return `Environment="${key}=${value.replace(/%/g, "%%").replace(/"/g, '\\"')}"`;
}

/** ExecStart takes a command line, so an installed-with-spaces path needs quotes. */
function execStart(parts: string[]): string {
  return parts.map((part) => (/[\s"]/.test(part) ? `"${part.replace(/"/g, '\\"')}"` : part)).join(" ");
}

export function buildUnit(options: InstallOptions = {}): string {
  const program = programArguments(options.bunPath);
  const runtime = options.bunPath ?? process.execPath;
  const logs = logDir(options.env);
  const port = options.port ?? Number(options.env?.PEW2_PORT ?? 8787);
  const path = options.env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin";

  const environment = [
    environmentLine("PATH", `${dirname(runtime)}:${path}`),
    environmentLine("PEW2_PORT", String(port)),
    environmentLine("HOME", options.home ?? homedir()),
  ];
  if (options.experimental) environment.push(environmentLine("PEW2_EXPERIMENTAL", "1"));
  if (options.env?.PEW2_HOME) environment.push(environmentLine("PEW2_HOME", options.env.PEW2_HOME));
  if (options.env?.PEW2_RELAY) {
    environment.push(environmentLine("PEW2_RELAY", options.env.PEW2_RELAY));
  }

  return `[Unit]
Description=pew2 daemon
Documentation=https://github.com/KenKaiii/pew2
# The daemon dials out to the relay on start. Without this it races DNS on a
# freshly booted machine and spends its first backoff cycle failing.
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart(program)}
${environment.join("\n")}

# The counterpart of launchd's KeepAlive, and it must be "always": "on-failure"
# ignores a clean exit, which is exactly how the self-updater restarts onto a
# new binary. See update/apply.ts.
Restart=always
# Matches the launchd plist's ThrottleInterval, so a crash-looping daemon backs
# off at the same rate on both platforms.
RestartSec=10

# The daemon rotates these itself, so systemd must append rather than truncate.
StandardOutput=append:${join(logs, "daemon.log")}
StandardError=append:${join(logs, "daemon.error.log")}

[Install]
WantedBy=default.target
`;
}

export interface SystemdDeps {
  runCommand: (command: string, args: string[]) => Promise<CommandResult>;
  home?: string;
}

export async function installSystemdUnit(
  options: InstallOptions,
  deps: SystemdDeps,
): Promise<ServiceStatus> {
  const home = options.home ?? deps.home ?? homedir();
  const path = unitPath(home);
  await mkdir(dirname(path), { recursive: true });
  await mkdir(logDir(options.env), { recursive: true });
  await writeFile(path, buildUnit(options), "utf8");

  // Without this the unit file on disk is invisible to a manager that is
  // already running.
  await deps.runCommand("systemctl", ["--user", "daemon-reload"]);

  // Survive logout. A user unit is stopped with the user's session otherwise,
  // so a machine the user is not currently logged into has no daemon — which is
  // the normal state for something a phone connects to. This is the one step
  // that can need a password, so a refusal is reported rather than fatal.
  const linger = await deps.runCommand("loginctl", ["enable-linger", userInfo().username]);

  const enabled = await deps.runCommand("systemctl", ["--user", "enable", "--now", UNIT_NAME]);
  if (enabled.code !== 0) {
    return {
      state: "installed",
      servicePath: path,
      detail: `Written, but systemctl enable failed: ${enabled.stdout.trim() || `exit ${enabled.code}`}`,
    };
  }

  const status = await systemdStatus(home, deps);
  if (linger.code !== 0 && status.state === "running") {
    return {
      ...status,
      detail:
        "Running, but lingering could not be enabled, so the daemon will stop when you " +
        `log out. Run: sudo loginctl enable-linger ${userInfo().username}`,
    };
  }
  return status;
}

export async function uninstallSystemdUnit(
  home: string,
  deps: SystemdDeps,
): Promise<ServiceStatus> {
  const path = unitPath(home);
  await deps.runCommand("systemctl", ["--user", "disable", "--now", UNIT_NAME]);
  await rm(path, { force: true });
  await deps.runCommand("systemctl", ["--user", "daemon-reload"]);
  return { state: "not-installed", servicePath: path };
}

export async function systemdStatus(home: string, deps: SystemdDeps): Promise<ServiceStatus> {
  const path = unitPath(home);
  const logPath = join(logDir(), "daemon.log");

  try {
    await readFile(path, "utf8");
  } catch {
    return { state: "not-installed", servicePath: path, logPath };
  }

  // One call, machine-readable: `show` prints `Key=value` lines and, unlike
  // `status`, exits zero for a unit that is merely stopped.
  const shown = await deps.runCommand("systemctl", [
    "--user",
    "show",
    UNIT_NAME,
    "--property=ActiveState,MainPID,ExecMainStatus",
  ]);
  if (shown.code !== 0) {
    return { state: "installed", servicePath: path, logPath, detail: "Registered but not loaded." };
  }

  const read = (key: string) => shown.stdout.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1]?.trim();
  const active = read("ActiveState");
  const pid = Number(read("MainPID") ?? 0);
  const exitCode = Number(read("ExecMainStatus") ?? 0);

  return {
    state: active === "active" && pid > 0 ? "running" : "installed",
    servicePath: path,
    logPath,
    pid: pid > 0 ? pid : undefined,
    lastExitCode: Number.isFinite(exitCode) ? exitCode : undefined,
  };
}
