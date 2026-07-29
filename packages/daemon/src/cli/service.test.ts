/**
 * Service tests.
 *
 * The plist is the whole feature: launchd starts the daemon with no shell, no
 * working directory and almost no environment, so anything wrong in this file
 * shows up as a daemon that silently fails to start after a reboot, with the
 * user nowhere near the machine.
 *
 * Nothing here touches the real launchd domain.
 */
import { test, expect } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { existsSync } from "node:fs";
import {
  LABEL,
  buildPlist,
  logDir,
  plistPath,
  reloadLaunchdJob,
  serverEntry,
} from "./service.js";
import { doctor } from "./doctor.js";

const bun = "/opt/homebrew/bin/bun";

test("the plist points at paths that exist and are absolute", () => {
  const entry = serverEntry();

  // launchd has no working directory, so a relative path here would simply
  // never start.
  expect(isAbsolute(entry)).toBe(true);
  expect(existsSync(entry)).toBe(true);
  expect(entry.endsWith("server.ts")).toBe(true);
});

test("carries a PATH including bun, so providers can be spawned", () => {
  const plist = buildPlist({ bunPath: bun, env: { PATH: "/usr/local/bin" } as NodeJS.ProcessEnv });

  // Without bun's own directory on PATH the daemon cannot start at all, and
  // without the inherited PATH every `npx` provider appears to be missing.
  expect(plist).toContain(`${dirname(bun)}:/usr/local/bin`);
  expect(plist).toContain(`<string>${bun}</string>`);
});

test("restarts on exit and starts at login", () => {
  const plist = buildPlist({ bunPath: bun });

  // A crashed daemon is a phone that silently stops working.
  expect(plist).toContain("<key>KeepAlive</key>\n    <true/>");
  expect(plist).toContain("<key>RunAtLoad</key>\n    <true/>");
  // launchd complains below 10 and throttles anyway.
  expect(plist).toContain("<key>ThrottleInterval</key>\n    <integer>10</integer>");
});

test("logs somewhere findable, since nothing is on screen", () => {
  const plist = buildPlist({ bunPath: bun });
  const logs = logDir();

  expect(plist).toContain(join(logs, "daemon.log"));
  expect(plist).toContain(join(logs, "daemon.error.log"));
});

test("passes through port, experimental and relay settings", () => {
  const plist = buildPlist({
    bunPath: bun,
    port: 9999,
    experimental: true,
    env: { PEW2_RELAY: "wss://relay.example.com", PEW2_HOME: "/tmp/home" } as NodeJS.ProcessEnv,
  });

  expect(plist).toContain("<string>9999</string>");
  expect(plist).toContain("<key>PEW2_EXPERIMENTAL</key>");
  expect(plist).toContain("wss://relay.example.com");
  expect(plist).toContain("<string>/tmp/home</string>");
});

test("omits experimental unless asked", () => {
  // The echo agent is a test fixture; it must not appear in a normal install.
  expect(buildPlist({ bunPath: bun })).not.toContain("PEW2_EXPERIMENTAL");
});

test("escapes values rather than producing malformed XML", () => {
  const plist = buildPlist({
    bunPath: bun,
    env: { PATH: "/opt/a&b", PEW2_RELAY: "wss://x?a=1&b=2" } as NodeJS.ProcessEnv,
  });

  // An unescaped ampersand makes launchd reject the whole file, which reads as
  // "install worked, service never runs".
  expect(plist).toContain("&amp;");
  expect(plist).not.toMatch(/&(?!amp;|lt;|gt;|quot;)/);
});

test("uses a stable reverse-DNS label under LaunchAgents", async () => {
  const home = await mkdtemp(join(tmpdir(), "pew2-home-"));
  const path = plistPath(home);

  expect(LABEL).toBe("dev.pew2.daemon");
  expect(path).toBe(join(home, "Library", "LaunchAgents", "dev.pew2.daemon.plist"));
  expect(buildPlist({ bunPath: bun })).toContain(`<string>${LABEL}</string>`);
});

test("doctor warns when the daemon will not survive a reboot", async () => {
  const report = await doctor({
    env: { PEW2_HOME: "/tmp/pew2-nonexistent" } as NodeJS.ProcessEnv,
    searchDirs: [],
    probeDaemon: async () => true,
    addresses: () => ["192.168.1.24"],
    pairing: async () => ({ token: "t".repeat(48), relay: "wss://relay.test" }),
    service: async () => ({ state: "not-installed" }),
  });

  const problem = report.problems.find((p) => p.id === "not-autostarted");
  expect(problem?.fix).toBe("pew2 service install");
  // A warning, not an error: running the daemon by hand is a legitimate choice
  // and an agent must not loop trying to "fix" it.
  expect(problem?.severity).toBe("warning");
  expect(report.daemon.autostart).toBe(false);
});

test("doctor stays quiet once the service is installed", async () => {
  const report = await doctor({
    env: { PEW2_HOME: "/tmp/pew2-nonexistent" } as NodeJS.ProcessEnv,
    searchDirs: [],
    probeDaemon: async () => true,
    addresses: () => ["192.168.1.24"],
    pairing: async () => ({ token: "t".repeat(48), relay: "wss://relay.test" }),
    service: async () => ({ state: "running" }),
  });

  expect(report.problems.map((p) => p.id)).not.toContain("not-autostarted");
  expect(report.daemon.autostart).toBe(true);
});

test("an unreachable daemon is not also reported as not-autostarted", async () => {
  const report = await doctor({
    env: { PEW2_HOME: "/tmp/pew2-nonexistent" } as NodeJS.ProcessEnv,
    searchDirs: [],
    probeDaemon: async () => false,
    addresses: () => ["192.168.1.24"],
    pairing: async () => ({ token: "t".repeat(48), relay: "wss://relay.test" }),
    service: async () => ({ state: "not-installed" }),
  });

  // Two fixes for one cause would make the agent's loop look like it is not
  // converging.
  expect(report.problems.map((p) => p.id)).toContain("daemon-unreachable");
  expect(report.problems.map((p) => p.id)).not.toContain("not-autostarted");
});

test("reload waits for launchd teardown and retries a raced bootstrap", async () => {
  const calls: string[] = [];
  const sleeps: number[] = [];
  let printAttempts = 0;
  let bootstrapAttempts = 0;

  const result = await reloadLaunchdJob({
    domain: "gui/501",
    path: "/tmp/dev.pew2.daemon.plist",
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
    },
    runCommand: async (_command, args) => {
      const action = args[0] ?? "";
      calls.push(action);
      if (action === "print") {
        printAttempts++;
        return { code: printAttempts === 1 ? 0 : 113, stdout: "" };
      }
      bootstrapAttempts++;
      return bootstrapAttempts === 1
        ? { code: 5, stdout: "Bootstrap failed: 5: Input/output error" }
        : { code: 0, stdout: "" };
    },
  });

  expect(result.code).toBe(0);
  expect(calls).toEqual(["print", "print", "bootstrap", "bootstrap"]);
  expect(sleeps).toEqual([200, 400]);
});

test("the generated plist parses as real XML", async () => {
  const plist = buildPlist({ bunPath: bun });
  const path = join(await mkdtemp(join(tmpdir(), "pew2-plist-")), "test.plist");
  await Bun.write(path, plist);

  // plutil is what launchd itself uses; a file it rejects will never load.
  const proc = Bun.spawn(["plutil", "-lint", path], { stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  expect(`${path}: ${await new Response(proc.stdout).text()}`.includes("OK")).toBe(true);
  expect(code).toBe(0);
  expect(await readFile(path, "utf8")).toContain(LABEL);
});
