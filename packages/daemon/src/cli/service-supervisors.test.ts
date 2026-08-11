/**
 * The Linux and Windows supervisors.
 *
 * What is actually being tested is one property, stated three different ways on
 * three platforms: **the daemon comes back after a clean exit**. Self-update
 * swaps the binary and then ends the process with status 0, so a supervisor
 * that only restarts on failure — which is the default advice on both platforms
 * — would leave the user with a new binary and no daemon.
 *
 * Text assertions on generated config, because that config is the contract with
 * an OS that is not this one. `bun test` runs on macOS here, so the unit file
 * and task XML cannot be executed; what can be checked is that the settings
 * which decide the behaviour are present and correct.
 */
import { test, expect } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildUnit, installSystemdUnit, unitPath, systemdStatus } from "./service-systemd.js";
import {
  TASK_NAME,
  buildTaskXml,
  installScheduledTask,
  scheduledTaskStatus,
  taskXmlPath,
} from "./service-schtasks.js";
import { supervisorPath, supervisorInstalled } from "./service.js";
import type { CommandResult } from "./service-shared.js";

/** Records every command a backend would have run, and answers as told. */
function recorder(answers: Record<string, CommandResult> = {}) {
  const calls: string[][] = [];
  const runCommand = async (command: string, args: string[]): Promise<CommandResult> => {
    calls.push([command, ...args]);
    const key = `${command} ${args[0] ?? ""}`.trim();
    return answers[key] ?? { code: 0, stdout: "" };
  };
  return {
    runCommand,
    calls,
    ran: (c: string) => calls.some((call) => call[0] === c),
    // The startup poll is 15 tries; in a test it should cost nothing.
    sleep: async () => {},
  };
}

// --- systemd ---------------------------------------------------------------

test("the unit restarts the daemon even when it exits cleanly", () => {
  // The whole point. `Restart=on-failure` — what most guides recommend — does
  // not restart a process that exited 0, which is exactly how the self-updater
  // ends the daemon: it would swap the binary and never come back.
  const unit = buildUnit();

  expect(unit).toContain("Restart=always");
  expect(unit).not.toContain("Restart=on-failure");
});

test("the unit backs off at the same rate as the launchd plist", () => {
  expect(buildUnit()).toContain("RestartSec=10");
});

test("the unit installs into the user's own systemd, never root's", () => {
  // pew2 spawns coding agents as the person using it — their HOME, their keys.
  // A system unit would run every agent as root.
  expect(unitPath("/home/ada")).toBe("/home/ada/.config/systemd/user/dev.pew2.daemon.service");
  expect(buildUnit()).toContain("WantedBy=default.target");
});

test("environment values are quoted, so a PATH with a space survives", () => {
  // Unquoted, `Environment=PATH=/a b/c` becomes two assignments and the daemon
  // silently loses the half of PATH that finds `npx`.
  const unit = buildUnit({ env: { PATH: "/opt/my tools/bin:/usr/bin" } });

  expect(unit).toContain('Environment="PATH=');
  expect(unit).toMatch(/Environment="PATH=[^"\n]*\/opt\/my tools\/bin/);
});

test("a percent sign is escaped, because systemd expands it", () => {
  // `%` is systemd's specifier prefix: unescaped, `%h` becomes the home
  // directory rather than the two characters that were meant.
  const unit = buildUnit({ env: { PEW2_RELAY: "wss://relay/%h%i" } });

  expect(unit).toContain("wss://relay/%%h%%i");
});

test("the unit waits for the network it immediately dials out on", () => {
  const unit = buildUnit();

  expect(unit).toContain("After=network-online.target");
  expect(unit).toContain("Wants=network-online.target");
});

test("logs are appended, never truncated, because the daemon rotates them", () => {
  const unit = buildUnit();

  expect(unit).toContain("StandardOutput=append:");
  expect(unit).toContain("StandardError=append:");
});

test("installing enables lingering, or says how to", async () => {
  // Without lingering, systemd tears down the user manager at logout and the
  // daemon dies with it — on a machine whose whole purpose is to be reachable
  // while nobody is sitting at it.
  const home = await mkdtemp(join(tmpdir(), "pew2-systemd-"));
  const rec = recorder({ "loginctl enable-linger": { code: 1, stdout: "denied" } });

  const status = await installSystemdUnit({ home }, rec);

  expect(rec.calls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
  expect(rec.calls.some((c) => c[0] === "loginctl" && c[1] === "enable-linger")).toBe(true);
  expect(rec.calls).toContainEqual([
    "systemctl",
    "--user",
    "enable",
    "--now",
    "dev.pew2.daemon.service",
  ]);
  // A refused linger is reported rather than silently accepted.
  if (status.state === "running") expect(status.detail).toContain("enable-linger");
});

test("a unit that was never written reads as not-installed", async () => {
  const home = await mkdtemp(join(tmpdir(), "pew2-systemd-"));
  const rec = recorder();

  const status = await systemdStatus(home, rec);

  expect(status.state).toBe("not-installed");
  // And nothing was asked of systemd about a unit that does not exist.
  expect(rec.ran("systemctl")).toBe(false);
});

test("systemd status reads the machine-readable form, not prose", async () => {
  const home = await mkdtemp(join(tmpdir(), "pew2-systemd-"));
  const rec = recorder({
    "systemctl --user": { code: 0, stdout: "ActiveState=active\nMainPID=4321\nExecMainStatus=0\n" },
  });
  await installSystemdUnit({ home }, recorder());

  const status = await systemdStatus(home, rec);

  expect(status).toMatchObject({ state: "running", pid: 4321 });
});

// --- Windows Task Scheduler ------------------------------------------------

test("the task restarts the daemon after a clean exit", () => {
  // Task Scheduler has no KeepAlive, and RestartOnFailure does not apply to a
  // task that succeeded. The keepalive is a repeating trigger that is ignored
  // while an instance is already running — so the first attempt after the
  // daemon exits is the one that starts it again.
  const xml = buildTaskXml();

  expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
  expect(xml).toContain("<Interval>PT1M</Interval>");
  expect(xml).toContain("<StopAtDurationEnd>false</StopAtDurationEnd>");
});

test("the task is never killed for running too long", () => {
  // The default execution time limit is three days, which would terminate a
  // daemon on a timer for no reason. PT0S means no limit.
  expect(buildTaskXml()).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
});

test("the task keeps running on battery, which is the normal case", () => {
  const xml = buildTaskXml();

  expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
  expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
});

test("the task runs as the user, not elevated", () => {
  // A real Windows service would need Administrator and run in session 0, away
  // from the user's environment — where their agents' credentials live.
  const xml = buildTaskXml();

  expect(xml).toContain("<LogonType>InteractiveToken</LogonType>");
  expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>");
});

test("a path with a space is quoted in the task's command line", async () => {
  // Task Scheduler passes Arguments as one string, split by the usual rules.
  const xml = buildTaskXml({ bunPath: "C:\\Program Files\\bun\\bun.exe" });

  expect(xml).toContain("&quot;C:\\Program Files\\bun\\bun.exe&quot;");
});

test("environment and log redirection are carried, since a task has neither", () => {
  const xml = buildTaskXml({ port: 9001, experimental: true });

  expect(xml).toContain('set &quot;PEW2_PORT=9001&quot;');
  expect(xml).toContain('set &quot;PEW2_EXPERIMENTAL=1&quot;');
  expect(xml).toContain("daemon.log");
});

test("installing registers the task and starts it without waiting for a logon", async () => {
  // A logon trigger does not fire until the next sign-in, so `pew2 setup` would
  // otherwise report success on a daemon that does not exist yet.
  const home = await mkdtemp(join(tmpdir(), "pew2-task-"));
  const rec = recorder({
    "schtasks /query": { code: 0, stdout: "Status:  Running\nLast Result: 0\n" },
  });

  const status = await installScheduledTask({ home }, rec);

  expect(rec.calls).toContainEqual(["schtasks", "/create", "/tn", TASK_NAME, "/xml", taskXmlPath(home), "/f"]);
  expect(rec.calls).toContainEqual(["schtasks", "/run", "/tn", TASK_NAME]);
  expect(status.state).toBe("running");
});

test("the task file is written as Unicode, which schtasks requires", async () => {
  const home = await mkdtemp(join(tmpdir(), "pew2-task-"));
  await installScheduledTask({ home }, recorder());

  // A plain UTF-8 file is rejected with a bare "The task XML is malformed".
  // Read as bytes: `.text()` decodes and strips the very mark being asserted.
  const bytes = new Uint8Array(await Bun.file(taskXmlPath(home)).arrayBuffer());
  expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);
});

test("a task that was never created reads as not-installed", async () => {
  const home = await mkdtemp(join(tmpdir(), "pew2-task-"));
  const rec = recorder();

  const status = await scheduledTaskStatus(home, rec);

  expect(status.state).toBe("not-installed");
  expect(rec.ran("schtasks")).toBe(false);
});

test("an unrecognised status is reported as installed, never as running", async () => {
  // Task Scheduler localises its output; guessing "running" from a string we
  // cannot read would tell the updater it is safe to exit when it is not.
  const home = await mkdtemp(join(tmpdir(), "pew2-task-"));
  await installScheduledTask({ home }, recorder());
  const rec = recorder({ "schtasks /query": { code: 0, stdout: "Status: En cours\n" } });

  expect((await scheduledTaskStatus(home, rec)).state).toBe("installed");
});

// --- the dispatcher --------------------------------------------------------

test("each platform is asked about its own service file", () => {
  expect(supervisorPath("darwin", "/home/ada")).toContain("Library/LaunchAgents");
  expect(supervisorPath("linux", "/home/ada")).toContain(".config/systemd/user");
  expect(supervisorPath("win32", "/home/ada")).toContain(".pew2");
  expect(supervisorPath("freebsd", "/home/ada")).toBeUndefined();
});

test("an empty home has no supervisor on any platform", async () => {
  const home = await mkdtemp(join(tmpdir(), "pew2-empty-"));

  for (const platform of ["darwin", "linux", "win32", "freebsd"] as const) {
    expect(supervisorInstalled(platform, home)).toBe(false);
  }
});

test("a written unit makes linux report a supervisor", async () => {
  const home = await mkdtemp(join(tmpdir(), "pew2-supervised-"));
  await installSystemdUnit({ home }, recorder());

  expect(supervisorInstalled("linux", home)).toBe(true);
  // ...and says nothing about the other platforms' files.
  expect(supervisorInstalled("darwin", home)).toBe(false);
});
