/**
 * A real daemon, in a real process, for tests that need the whole pipeline.
 *
 * Everything else in this suite tests a piece: `handler.test.ts` calls
 * `handleMessage` directly, `index.test.ts` drives a `Daemon` with its spawning
 * stubbed out. Both are fast and neither can see the bugs that only exist
 * *between* the parts — a frame the daemon broadcasts to every client, a socket
 * that dies mid-turn, two devices disagreeing about which session is theirs.
 * Those were found by hand on a phone, repeatedly, because nothing here could
 * find them.
 *
 * So this spawns `server.ts` exactly as a user's machine runs it: real socket,
 * real encryption, real agent processes. The cost is roughly a second per
 * daemon, which is why tests share one.
 *
 * Isolated from the developer's machine on every axis that could leak:
 * `HOME` is a fresh temp directory, so stored preferences, workspaces and logs
 * belong to the test rather than to whoever ran it; `PEW2_TOKEN` derives the
 * pairing rather than minting and storing one; `PEW2_PORT=0` lets the OS pick a
 * free port, so parallel runs cannot collide on a hardcoded one; and every
 * other `PEW2_*` variable is dropped, because a developer with `PEW2_RELAY` set
 * would otherwise have their tests dial a real relay.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pairingFromToken } from "../pairing.js";

/** Four levels up from `packages/daemon/src/testing`. */
const repoRoot = resolve(import.meta.dir, "../../../..");

/**
 * How long the daemon may take to announce its port.
 *
 * Generous because a cold `bun run` on a loaded CI box is genuinely slow, and
 * the failure mode of being too tight is a flaky suite that everyone learns to
 * re-run — which is worse than a slow one.
 */
const START_TIMEOUT_MS = 30_000;

export interface RunningDaemon {
  /** The port the OS assigned, read back from the daemon's own announcement. */
  readonly port: number;
  /**
   * The LAN connection token, which is also the relay room id.
   *
   * Derived from the key, not the `PEW2_TOKEN` secret that seeded it — the
   * daemon checks this value on the query string, and connecting with the
   * secret instead is refused with a 401 before the socket is ever upgraded.
   */
  readonly token: string;
  /** The root key, hex, as the pairing QR carries it. */
  readonly key: string;
  /** Everything the daemon has written to stdout and stderr so far. */
  output(): string;
  /**
   * Why the daemon is gone, or undefined while it is running.
   *
   * Clients ask before reporting a connection failure. A daemon that crashed
   * mid-suite otherwise turns every later test into "socket failed to open",
   * which says nothing about the crash that caused it — the first real
   * regression found with this harness was read that way for several minutes.
   */
  died(): string | undefined;
  /** Stop the daemon and remove its temporary home. */
  stop(): Promise<void>;
}

export interface DaemonOptions {
  /**
   * The pairing secret, which both the root key and the connection token are
   * derived from.
   *
   * Fixed rather than random by default so a failing test can be re-run against
   * the same pairing, and so two daemons in one test can be given deliberately
   * *different* pairings to prove they cannot read each other.
   */
  secret?: string;
  /** Extra environment, for tests that need to vary the daemon's behaviour. */
  env?: Record<string, string>;
}

/**
 * A secret long enough to satisfy `pairingFromToken`, which refuses a short one
 * rather than deriving a guessable key from it.
 */
const DEFAULT_SECRET = "pew2-test-pairing-secret-0123456789abcdef";

/**
 * Spawn a daemon and wait until it is listening.
 *
 * Resolves only once the port has been announced *and* `/health` answers, so a
 * caller never races the socket. A daemon that dies during startup rejects with
 * its own output attached — without that, a crashed daemon read as a timeout
 * and hid the actual error.
 */
export async function startDaemon(options: DaemonOptions = {}): Promise<RunningDaemon> {
  const secret = options.secret ?? DEFAULT_SECRET;
  const { token, key } = pairingFromToken(secret);
  const home = await mkdtemp(join(tmpdir(), "pew2-e2e-"));

  // Rebuilt rather than spread over: a developer's `PEW2_RELAY` would make the
  // test daemon dial a real relay, and `PEW2_EXPERIMENTAL` unset would hide the
  // echo agent every scenario here depends on.
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined && !name.startsWith("PEW2_")) env[name] = value;
  }
  Object.assign(env, {
    HOME: home,
    PEW2_PORT: "0",
    PEW2_TOKEN: secret,
    // Surfaces the echo agent, which is the only provider that can run with no
    // API key and no network.
    PEW2_EXPERIMENTAL: "1",
    ...options.env,
  });

  const proc = Bun.spawn(["bun", "run", "packages/daemon/src/server.ts"], {
    cwd: repoRoot,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let output = "";
  let exited = false;
  let stopping = false;
  let notify: (() => void) | undefined;

  // Drained continuously, not read once at the end. A pipe that fills blocks
  // the process writing to it, so a daemon left undrained would freeze mid-test
  // the moment it logged enough — an unusually confusing hang to debug.
  const drain = async (stream: ReadableStream<Uint8Array>) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      output += decoder.decode(value, { stream: true });
      notify?.();
    }
  };
  void drain(proc.stdout).catch(() => {});
  void drain(proc.stderr).catch(() => {});
  void proc.exited.then(() => {
    exited = true;
    notify?.();
  });

  // Anything that throws between here and the returned handle has to clean up
  // after itself: `stop()` is only reachable through that handle, so a daemon
  // that fails to start would otherwise sit there holding a port, its temp
  // home, and every agent it had already spawned — for the rest of the run, on
  // the loaded machine that made it slow in the first place.
  try {
    const port = await new Promise<number>((resolvePort, reject) => {
      const deadline = setTimeout(() => {
        finish();
        reject(new Error(`daemon did not start within ${START_TIMEOUT_MS}ms:\n${output}`));
      }, START_TIMEOUT_MS);

      const finish = () => {
        clearTimeout(deadline);
        notify = undefined;
      };

      const check = () => {
        const match = output.match(/pew2 daemon listening on port (\d+)/);
        if (match) {
          finish();
          resolvePort(Number(match[1]));
          return;
        }
        // A daemon that died on startup will never print the line, so waiting
        // for the full timeout would report "did not start" and bury the reason.
        if (exited) {
          finish();
          reject(new Error(`daemon exited during startup:\n${output}`));
        }
      };

      notify = check;
      check();
    });

    // The port is announced from the same statement that starts the server, so
    // it is already accepting connections — but proving it here means a failure
    // says "daemon never became healthy" rather than surfacing as a refused
    // socket inside whichever test happened to connect first.
    await waitForHealth(port, output);
    return handle(port);
  } catch (error) {
    stopping = true;
    proc.kill();
    await proc.exited;
    await rm(home, { recursive: true, force: true }).catch(() => {});
    throw error;
  }

  function handle(port: number): RunningDaemon {
    return {
      port,
      token,
      key,
      output: () => output,
      died: () =>
        exited && !stopping
          ? `the daemon exited (code ${proc.exitCode}). Its output:\n${output}`
          : undefined,
      stop: async () => {
        // Past this point an exit is the expected one, not a crash to report.
        stopping = true;
        // SIGTERM rather than SIGKILL: the daemon's shutdown handler closes the
        // agents it spawned, and killing it outright orphans them. A test suite
        // leaking an agent process per scenario is the same leak that once left
        // 33 of them holding 2.3GB on a developer's machine.
        proc.kill();
        await proc.exited;
        await rm(home, { recursive: true, force: true }).catch(() => {});
      },
    };
  }
}

/** Poll `/health` until it answers, which is the daemon's own liveness signal. */
async function waitForHealth(port: number, output: string): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`);
      if (response.ok) return;
    } catch {
      // Not up yet.
    }
    await Bun.sleep(25);
  }
  throw new Error(`daemon on port ${port} never became healthy:\n${output}`);
}
