// POSIX-only: every mechanism here is process groups and signals, and the
// Windows half (`taskkill /T`, `tasklist`) has no equivalent to assert against
// on this runner. `DETACH_CHILDREN` is the one part that is checked everywhere.
import { expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import {
  DETACH_CHILDREN,
  killOwnedChildren,
  registerChild,
  sweepOrphans,
  terminateChild,
  unregisterChild,
} from "./children.js";

test("children are only detached where a process group means what we need", () => {
  // On Windows the same flag means "survive the parent", which is the leak this
  // module exists to close rather than a way to close it.
  expect(DETACH_CHILDREN).toBe(process.platform !== "win32");
});

async function home(): Promise<NodeJS.ProcessEnv> {
  return { PEW2_HOME: await mkdtemp(join(tmpdir(), "pew2-children-")) } as NodeJS.ProcessEnv;
}

/**
 * A process that ignores SIGTERM, standing in for an agent that does.
 *
 * `sleep 30 & wait` rather than a bare `sleep 30`: bash `exec`s a lone final
 * command, and the trap goes with it — the stub was then a plain `sleep` that
 * died on the first SIGTERM, the exact opposite of its purpose. Backgrounding
 * leaves bash in charge, so the trap holds.
 *
 * Not a `while` loop either, tempting as it is. That respawns `sleep` several
 * times a second, and the churn made the `ps` reads these tests depend on come
 * back empty.
 */
function stubborn(): ReturnType<typeof spawn> {
  return spawn("bash", ["-c", "trap '' TERM; sleep 30 & wait"], {
    stdio: "ignore",
    detached: true,
  });
}

/**
 * Wait until a stub is actually ignoring signals.
 *
 * The `spawn` event fires when the process is forked, which is *before* bash has
 * read its script and installed the trap. Signalling then raced an un-trapped
 * shell and killed it, so the escalation tests passed for the wrong reason and
 * the shutdown test failed outright, having asserted the process was still up.
 *
 * A delay rather than a handshake over stdout: these stubs are spawned with no
 * pipes, several at a time, and adding one purely to synchronise a test made
 * three of them hang.
 */
const armed = () => new Promise((resolve) => setTimeout(resolve, 250));

const settled = () => new Promise((resolve) => setTimeout(resolve, 150));

/** Skipped on Windows, which has neither process groups nor `ps`. */
const posixTest = process.platform === "win32" ? test.skip : test;

posixTest("terminateChild escalates to SIGKILL when SIGTERM is ignored", async () => {
  const child = stubborn();
  await armed();
  let exited = false;
  child.once("exit", () => (exited = true));

  terminateChild(child.pid!, () => exited, 100);
  await new Promise((resolve) => setTimeout(resolve, 400));

  // Without the escalation this process is still sleeping: the whole point is
  // that a SIGTERM an agent declines to honour is not the end of the exchange.
  expect(exited).toBe(true);
});

posixTest("terminateChild reaches a grandchild behind a wrapper", async () => {
  // Stands in for `npx <agent>`: the process pew2 spawned is a launcher, and
  // killing only it would reparent the real agent to pid 1 forever.
  // The pid is handed over through a file, not a pipe. A piped stdout from a
  // detached child never delivers under this Bun, so the read hung until the
  // 5s test timeout — and the timing-out test left the runtime in a state where
  // every later `ps` in this file read back empty, failing two more tests that
  // were themselves correct.
  const relay = join(await mkdtemp(join(tmpdir(), "pew2-relay-")), "pid");
  const child = spawn("bash", ["-c", `sleep 30 & echo $! > ${relay}; wait`], {
    stdio: "ignore",
    detached: true,
  });
  let grandchild = 0;
  for (let attempt = 0; attempt < 50 && !grandchild; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    grandchild = Number((await readFile(relay, "utf8").catch(() => "")).trim());
  }
  expect(grandchild).toBeGreaterThan(0);
  let exited = false;
  child.once("exit", () => (exited = true));

  terminateChild(child.pid!, () => exited, 100);
  await new Promise((resolve) => setTimeout(resolve, 400));

  expect(() => process.kill(grandchild, 0)).toThrow();
});

posixTest("sweepOrphans kills children of a dead daemon and leaves live ones alone", async () => {
  const env = await home();
  const orphan = stubborn();
  const owned = stubborn();
  // Stands in for a second daemon that is still running. It has to be a real,
  // live pid that is *not* this process: the sweep runs once at module load,
  // before a daemon has registered anything, so a record naming our own pid is
  // a dead daemon's whose number we inherited — an orphan, not a live child.
  const otherDaemon = stubborn();
  await armed();

  // Recorded through `registerChild`, the same path production uses, then each
  // record's owner rewritten. Reading the command line here with its own `ps`
  // call was the flake: that read comes back empty inside this file while
  // exiting 0 (Bun #32067, the trap CLAUDE.md records for spawned children), so
  // every record stored `""`, matched nothing, and the sweep correctly did
  // nothing.
  await registerChild({ pid: orphan.pid!, providerId: "echo", fallbackCommand: "echo" }, env);
  await registerChild({ pid: owned.pid!, providerId: "echo", fallbackCommand: "echo" }, env);

  const registryFile = join(env.PEW2_HOME!, "children.json");
  const records = JSON.parse(await readFile(registryFile, "utf8")) as { pid: number }[];
  await writeFile(
    registryFile,
    JSON.stringify(
      records.map((record) =>
        record.pid === orphan.pid
          ? // An owner pid high enough to be certain nothing is running on it.
            { ...record, ownerPid: 999_999 }
          : { ...record, ownerPid: otherDaemon.pid },
      ),
    ),
  );

  const killed = await sweepOrphans(env);
  await settled();

  expect(killed).toEqual([orphan.pid!]);
  // The other daemon's agent is untouched: two daemons on one machine is a
  // normal state, and stealing each other's processes is worse than the leak.
  expect(() => process.kill(owned.pid!, 0)).not.toThrow();

  owned.kill("SIGKILL");
  otherDaemon.kill("SIGKILL");
});

posixTest("a record naming this process is a reused pid, not a live child", async () => {
  // The sweep's one call site is a top-level `await` in `server.ts`, reached
  // before any child exists. So `ownerPid === process.pid` cannot mean "mine,
  // still running" — it means a previous daemon died and the OS handed us its
  // number. Sparing those was a real leak: the agent survived every restart
  // that inherited the pid, with nothing left alive that knew to kill it.
  const env = await home();
  const inherited = stubborn();
  await armed();

  await registerChild({ pid: inherited.pid!, providerId: "echo", fallbackCommand: "echo" }, env);

  expect(await sweepOrphans(env)).toEqual([inherited.pid!]);
});

posixTest("sweepOrphans spares a pid that has been reused by something else", async () => {
  const env = await home();
  const innocent = stubborn();
  // `armed()`, not the `spawn` event: that fires before bash installs its trap,
  // and every other test here waits the same way.
  await armed();

  await writeFile(
    join(env.PEW2_HOME!, "children.json"),
    JSON.stringify([
      {
        pid: innocent.pid,
        ownerPid: 999_999,
        providerId: "echo",
        // What the registry recorded is not what is running on that number now.
        command: "npx some-agent --acp",
        startedAt: Date.now(),
      },
    ]),
  );

  expect(await sweepOrphans(env)).toEqual([]);
  expect(() => process.kill(innocent.pid!, 0)).not.toThrow();

  innocent.kill("SIGKILL");
});

posixTest("register and unregister round-trip through the registry file", async () => {
  // Every entry point takes the environment explicitly. It used to be read from
  // `process.env` inside the write, which meant a caller passing a temp home
  // read one file and rewrote a different one — in a test, the real registry.
  const env = await home();
  const path = join(env.PEW2_HOME!, "children.json");

  const child = stubborn();
  await armed();

  await registerChild({ pid: child.pid!, providerId: "goose", fallbackCommand: "goose acp" }, env);
  const stored = JSON.parse(await readFile(path, "utf8"));
  expect(stored).toHaveLength(1);
  expect(stored[0]).toMatchObject({ pid: child.pid!, providerId: "goose", ownerPid: process.pid });
  // Recorded as the kernel reports it, not as the manifest asked for it: the
  // sweep compares against `ps`, and "goose acp" never equals what `ps` prints.
  expect(stored[0].command).toContain("sleep 30");

  child.kill("SIGKILL");
  await unregisterChild(child.pid!, env);
  expect(JSON.parse(await readFile(path, "utf8"))).toEqual([]);
});

posixTest("killOwnedChildren finishes off an agent that ignored the shutdown SIGTERM", async () => {
  // The gap this closes: `close()` sends SIGTERM and schedules an escalation,
  // but on shutdown that timer dies with the daemon a moment later. Without a
  // synchronous kill before exit, a provider that declines SIGTERM survives its
  // daemon exactly as before this fix.
  const env = await home();
  const child = stubborn();
  await armed();
  let exited = false;
  child.once("exit", () => (exited = true));
  await registerChild({ pid: child.pid!, providerId: "echo", fallbackCommand: "bash" }, env);

  child.kill("SIGTERM");
  await settled();
  expect(exited).toBe(false);

  // `toContain` rather than equality: the owned set is module state shared by
  // every test in this file, so asserting its exact contents would couple this
  // test to the order the others run in.
  expect(killOwnedChildren()).toContain(child.pid!);
  await settled();
  expect(exited).toBe(true);

  // Draining is the point: a second call must not signal numbers it already
  // killed, which by then may belong to someone else.
  expect(killOwnedChildren()).toEqual([]);
});
