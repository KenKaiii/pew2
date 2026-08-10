/**
 * What counts as "installed" — the question every screen in setup is built on.
 *
 * This used to be `existsSync(join(dir, command))`, which is right on POSIX by
 * luck and wrong on Windows in both directions at once:
 *
 *  - `npm install -g` writes three files per binary. `agent.cmd` is the Windows
 *    shim, `agent.ps1` the PowerShell one, and plain `agent` is a **Bash**
 *    script for Git Bash and Cygwin. The extensionless check matched that sh
 *    script, so every npm-installed agent was reported installed on Windows and
 *    then failed at spawn — libuv appends only `.com` and `.exe` and never reads
 *    PATHEXT, so it never even sees the `.cmd`.
 *  - Conversely nothing on disk is named `cursor-agent`, only `cursor-agent.exe`
 *    — so a perfectly good install was reported missing.
 *
 * The Windows half is asserted through an injected env on every platform, since
 * CI is Linux-only and the real bug was never once reproducible there.
 */
import { test, expect } from "bun:test";
import { mkdtemp, writeFile, chmod, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { findOnPath } from "./registry.js";
import { launchSpec } from "../acp/connect.js";

const WINDOWS = process.platform === "win32";

async function bin(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "pew2-path-"));
}

test("an executable on PATH is found, with its full path", async () => {
  const dir = await bin();
  const file = join(dir, WINDOWS ? "agent.cmd" : "agent");
  await writeFile(file, "#!/bin/sh\n");
  await chmod(file, 0o755);

  expect(findOnPath("agent", { PATH: dir })).toBe(file);
});

test("a file that is not executable is not a command", async () => {
  if (WINDOWS) return; // The execute bit is a POSIX concept.
  const dir = await bin();
  const file = join(dir, "agent");
  await writeFile(file, "#!/bin/sh\n");
  await chmod(file, 0o644);

  // Reporting this as installed produces EACCES at spawn — a crash report for
  // something the machine could have told us up front.
  expect(findOnPath("agent", { PATH: dir })).toBeUndefined();
});

test("a directory of the right name is not a command", async () => {
  const dir = await bin();
  await mkdir(join(dir, "agent"));

  // `existsSync` said yes to this, and a directory spawns as EACCES.
  expect(findOnPath("agent", { PATH: dir })).toBeUndefined();
});

test("missing PATH entries and empty PATH are survivable", async () => {
  expect(findOnPath("agent", {})).toBeUndefined();
  expect(findOnPath("agent", { PATH: "" })).toBeUndefined();
  expect(findOnPath("agent", { PATH: `/nonexistent${delimiter}/also/nope` })).toBeUndefined();
});

test("an absolute path is checked directly, not searched for", async () => {
  const dir = await bin();
  const file = join(dir, WINDOWS ? "agent.exe" : "agent");
  await writeFile(file, "");
  await chmod(file, 0o755);

  expect(findOnPath(file, { PATH: "" })).toBe(file);
  expect(findOnPath(join(dir, "absent"), { PATH: dir })).toBeUndefined();
});

test("launchSpec passes POSIX commands through untouched", () => {
  if (WINDOWS) return;
  // The Windows handling must never reach into the platform that was working:
  // resolving here would replace `npx` with a path, and wrapping would put
  // cmd.exe on a Mac.
  expect(launchSpec("npx", ["-y", "pkg", "--acp"])).toEqual({
    command: "npx",
    args: ["-y", "pkg", "--acp"],
  });
});

/**
 * Windows, simulated.
 *
 * `PEW2_FAKE_PLATFORM` exists for these: the CI matrix is Linux-only, so
 * without it the rules that decide whether pew2 works at all on Windows are the
 * one part of the codebase that nothing ever runs.
 */
const win = (dir: string, extra: NodeJS.ProcessEnv = {}) => ({
  PEW2_FAKE_PLATFORM: "win32",
  PATH: dir,
  ...extra,
});

/** The three files `npm install -g` really writes for one binary. */
async function npmShim(dir: string, name: string) {
  // Extensionless, and a *Bash* script — unrunnable by any Win32 spawn.
  await writeFile(join(dir, name), "#!/bin/sh\nexec node ...\n");
  await writeFile(join(dir, `${name}.cmd`), "@ECHO OFF\r\n");
  await writeFile(join(dir, `${name}.ps1`), "#!/usr/bin/env pwsh\n");
}

test("windows: an npm shim resolves to the .cmd, never the bash script", async () => {
  const dir = await bin();
  await npmShim(dir, "npx");

  // The bug in one assertion. `existsSync(join(dir, "npx"))` matched the sh
  // script, so setup reported every npm-installed agent as present and every
  // one of them then died at spawn with ENOENT — libuv tries only `.com` and
  // `.exe`, and never reads PATHEXT.
  expect(findOnPath("npx", win(dir))).toBe(join(dir, "npx.cmd"));
});

test("windows: a .exe install is found", async () => {
  const dir = await bin();
  await writeFile(join(dir, "cursor-agent.exe"), "");

  // The other direction: nothing on disk is named `cursor-agent`, so the old
  // check reported a working install as missing.
  expect(findOnPath("cursor-agent", win(dir))).toBe(join(dir, "cursor-agent.exe"));
});

test("windows: PATHEXT decides, and order within it is honoured", async () => {
  const dir = await bin();
  await writeFile(join(dir, "agent.cmd"), "");
  await writeFile(join(dir, "agent.exe"), "");

  // Default PATHEXT lists .EXE before .CMD, and the shell takes the first hit.
  expect(findOnPath("agent", win(dir, { PATHEXT: ".EXE;.CMD" }))).toBe(join(dir, "agent.exe"));
  expect(findOnPath("agent", win(dir, { PATHEXT: ".CMD;.EXE" }))).toBe(join(dir, "agent.cmd"));

  // A suffix absent from PATHEXT is not executable, whatever it is called.
  expect(findOnPath("agent", win(dir, { PATHEXT: ".COM" }))).toBeUndefined();
});

test("windows: a .ps1 alone does not count as installed", async () => {
  const dir = await bin();
  await writeFile(join(dir, "agent.ps1"), "");

  // PowerShell scripts are not in the default PATHEXT and cannot be spawned
  // directly — claiming this is installed would be the npm-shim bug again.
  expect(findOnPath("agent", win(dir))).toBeUndefined();
});

test("windows: PATH splits on ';' and tolerates quoted entries", async () => {
  const dir = await bin();
  await writeFile(join(dir, "agent.exe"), "");

  // `path.delimiter` is the *host's*, so a simulated run must not use it — and
  // a real Windows PATH quotes entries containing spaces.
  expect(findOnPath("agent", win(`C:\\nope;"${dir}"`))).toBe(join(dir, "agent.exe"));
});

test("windows: an explicit extension is taken as given", async () => {
  const dir = await bin();
  await writeFile(join(dir, "agent.exe"), "");

  expect(findOnPath("agent.exe", win(dir))).toBe(join(dir, "agent.exe"));
  // Not silently upgraded to `agent.exe.exe`, nor to the `.exe` that exists.
  expect(findOnPath("agent.cmd", win(dir))).toBeUndefined();
});

test("windows: a batch shim is launched through cmd.exe, not spawned directly", async () => {
  const dir = await bin();
  await npmShim(dir, "npx");

  const spec = launchSpec("npx", ["-y", "@scope/agent@latest", "--acp"], win(dir));

  // Since CVE-2024-27980, Node refuses to spawn .cmd/.bat without a shell —
  // EINVAL, not ENOENT — so this is the only way a .cmd agent starts at all.
  expect(spec.command).toBe("cmd.exe");
  // `/d` suppresses registry AutoRun; `/s` makes the outer quotes mean exactly
  // "strip these two", which is the shape the line below is built for.
  expect(spec.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
  // One argument after `/c`, wrapped in the quotes `/s` strips — never separate
  // argv entries, which Node would re-quote into something cmd mis-parses.
  expect(spec.args).toHaveLength(4);
  expect(spec.args[3]!.startsWith('"')).toBe(true);
  expect(spec.args[3]).toContain("npx.cmd");
  expect(spec.args[3]).toContain("@scope/agent@latest");
  // And Node must not touch what was escaped by hand.
  expect(spec.windowsVerbatimArguments).toBe(true);
});

test("windows: a program path containing spaces survives cmd's quote stripping", async () => {
  // `C:\Program Files\nodejs` is where the Node installer puts npx, so this is
  // the common case, not an edge one. Passing the parts as ordinary argv looks
  // correct and is not: `/s` strips the first and last quote of everything
  // after `/c`, which unquotes the program path and splits it at the space.
  const root = await mkdtemp(join(tmpdir(), "pew2 path "));
  await npmShim(root, "npx");

  const spec = launchSpec("npx", ["--acp"], win(root));
  const line = spec.args[3]!;

  // The space is escaped for cmd rather than quoted, so nothing later strips it.
  expect(line).toContain("^ ");
  // Strip the outer quotes exactly as `/s` does; the path must still be intact.
  const inner = line.slice(1, -1);
  expect(inner.replace(/\^/g, "")).toContain(join(root, "npx.cmd"));
});

test("windows: an argument cannot break out of the command line", async () => {
  const dir = await bin();
  await npmShim(dir, "agent");

  // A session cwd or prompt argument is not something a manifest author picked.
  // `shell: true` would run the `&&` — that is CVE-2024-27980's whole shape.
  const spec = launchSpec("agent", ['x" && calc.exe && "', "a|b", "%PATH%"], win(dir));
  const line = spec.args[3]!;

  // Every metacharacter is neutralised: `&`, `|` and `%` reach the agent as
  // text, and the quote is escaped rather than closing the argument.
  expect(line).not.toMatch(/[^^]&&/);
  expect(line).not.toMatch(/[^^]\|/);
  expect(line).toContain("^%");
  expect(line).toContain('\\^"');
});

test("windows: a real executable is spawned directly, at its resolved path", async () => {
  const dir = await bin();
  await writeFile(join(dir, "cursor-agent.exe"), "");

  // No cmd.exe in the way: wrapping an .exe would add a process, and with it a
  // second thing that has to be killed when a session ends.
  expect(launchSpec("cursor-agent", ["acp"], win(dir))).toEqual({
    command: join(dir, "cursor-agent.exe"),
    args: ["acp"],
  });
});

test("windows: an unresolvable command still reaches spawn, to fail as ENOENT", async () => {
  const dir = await bin();

  // Refusing here would report "not installed" for something the user may have
  // put on PATH since the registry last looked; a real spawn gives a real error.
  expect(launchSpec("absent", ["--acp"], win(dir))).toEqual({
    command: "absent",
    args: ["--acp"],
  });
});

test("windows: COMSPEC is honoured when set", async () => {
  const dir = await bin();
  await npmShim(dir, "agent");

  const spec = launchSpec("agent", [], win(dir, { COMSPEC: "C:\\Windows\\System32\\cmd.exe" }));
  expect(spec.command).toBe("C:\\Windows\\System32\\cmd.exe");
});
