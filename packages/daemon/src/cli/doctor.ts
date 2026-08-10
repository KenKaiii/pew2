/**
 * Diagnosis as data.
 *
 * This is the contract that makes one-command setup work when a coding agent is
 * driving it: every problem carries a stable `id`, a human `detail`, and a `fix`
 * that is either a shell command or a precise instruction. The agent runs the
 * fix, runs `doctor` again, and stops when `ok` is true. Prose in console output
 * cannot support that loop; a machine-readable problem list can.
 *
 * `ok` is deliberately about *blocking* problems only. A missing optional API
 * key on an agent that has its own login flow is a warning, not a failure, and
 * must not trap an agent in a loop it cannot escape.
 */
import { loadProviders, isAvailable, unavailableReason, providerDirs } from "../providers/registry.js";
import {
  lanAddresses,
  MIN_TOKEN_LENGTH,
  pairingFromToken,
  pairingPath,
  pairingUrl,
} from "../pairing.js";
import { isCompiled, serviceStatus } from "./service.js";
import { readFile } from "node:fs/promises";

export interface StoredPairing {
  token?: string;
  /** Root key, hex. Absent in a pairing written before encryption existed. */
  key?: string;
  relay?: string;
}

/**
 * The stored pairing, or `undefined` when none exists.
 *
 * Deliberately does not create one: a diagnosis must never have side effects,
 * and an absent token is not a problem — starting the daemon mints it.
 */
async function readPairing(env: NodeJS.ProcessEnv): Promise<StoredPairing | undefined> {
  if (env.PEW2_TOKEN) {
    try {
      return { ...pairingFromToken(env.PEW2_TOKEN), relay: env.PEW2_RELAY };
    } catch {
      // A `PEW2_TOKEN` below the entropy floor. `doctor` is the command someone
      // runs *because* something is wrong, so it reports that as a problem
      // rather than throwing the same error the daemon already refused to start
      // with — a diagnosis that crashes tells them less than the failure did.
      return env.PEW2_RELAY ? { relay: env.PEW2_RELAY } : undefined;
    }
  }
  try {
    const parsed = JSON.parse(await readFile(pairingPath(env), "utf8")) as StoredPairing;
    return {
      token: typeof parsed.token === "string" ? parsed.token : undefined,
      relay: env.PEW2_RELAY ?? (typeof parsed.relay === "string" ? parsed.relay : undefined),
    };
  } catch {
    return env.PEW2_RELAY ? { relay: env.PEW2_RELAY } : undefined;
  }
}

export type Severity = "error" | "warning";

export interface Problem {
  /** Stable identifier. Agents branch on this, never on the message. */
  id:
    | "no-providers"
    | "manifest-invalid"
    | "provider-missing-env"
    | "daemon-unreachable"
    | "not-paired"
    | "no-lan-address"
    | "local-only"
    | "not-autostarted";
  severity: Severity;
  /** The provider this concerns, when it concerns one. */
  provider?: string;
  detail: string;
  /** A shell command to run, or an instruction when no command can fix it. */
  fix: string;
}

export interface DoctorReport {
  /** True when nothing blocking remains. This is the agent's stop condition. */
  ok: boolean;
  providerDirs: string[];
  providers: {
    id: string;
    available: boolean;
    source: string;
    reason?: string;
  }[];
  daemon: { url: string; reachable: boolean; autostart: boolean };
  /**
   * How a phone reaches this machine.
   *
   * `remote` is the one that matters for the product promise: without a relay,
   * the phone only works on the same Wi-Fi, which is not what "remote control"
   * means to a user standing in a different building.
   */
  pairing: { url?: string; addresses: string[]; relay?: string; remote: boolean };
  problems: Problem[];
}

/**
 * How to start a daemon by hand, for whichever install this is.
 *
 * The hardcoded `bun run packages/daemon/src/server.ts` is only true inside a
 * source checkout. Someone who ran the curl installer has no such directory,
 * and being handed a path that does not exist reads as pew2 not knowing what it
 * shipped — on the screen whose entire job is telling them what to do next.
 */
function daemonStartCommand(): string {
  return isCompiled() ? "pew2 serve" : "PEW2_EXPERIMENTAL=1 bun run packages/daemon/src/server.ts";
}

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  /** Directories scanned for manifests. Defaults to `providerDirs(env)`. */
  searchDirs?: string[];
  /** Injectable so tests never depend on a real socket. */
  probeDaemon?: (url: string) => Promise<boolean>;
  /** Injectable so tests never depend on the host's real network interfaces. */
  addresses?: () => string[];
  /** Injectable so tests never inspect the real launchd domain. */
  // `lastExitCode` distinguishes a service that has never run from one that is
  // restarting on a loop, which is the difference between "not started" and
  // "starts and dies".
  service?: () => Promise<{ state: string; lastExitCode?: number }>;
  /**
   * Read the stored pairing. Injectable so a diagnosis never mints one as a
   * side effect — `doctor` must be safe to run without changing anything.
   */
  pairing?: (env: NodeJS.ProcessEnv) => Promise<StoredPairing | undefined>;
}

export function daemonPort(env: NodeJS.ProcessEnv = process.env): number {
  return Number(env.PEW2_PORT ?? 8787);
}

export function daemonUrl(env: NodeJS.ProcessEnv = process.env): string {
  return `http://127.0.0.1:${daemonPort(env)}`;
}

/**
 * Is a daemon already serving?
 *
 * A short timeout on purpose: an unreachable daemon is the normal state before
 * setup has run, so this must fail fast rather than stall the diagnosis.
 */
async function defaultProbe(url: string): Promise<boolean> {
  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(1_500),
    });
    return response.ok;
  } catch {
    return false;
  }
}

export async function doctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const dirs = options.searchDirs ?? providerDirs(env);
  // Built-in agents only when the caller did not name directories of its own.
  const bundled = options.searchDirs === undefined;
  const { providers, errors } = await loadProviders(dirs, env, { bundled });
  const problems: Problem[] = [];

  for (const error of errors) {
    problems.push({
      id: "manifest-invalid",
      severity: "error",
      detail: error.message,
      fix: `Fix or delete ${error.source}`,
    });
  }

  if (providers.length === 0) {
    problems.push({
      id: "no-providers",
      severity: "error",
      detail: "No agents configured.",
      fix: "pew2 detect",
    });
  }

  for (const provider of providers) {
    if (isAvailable(provider)) continue;

    // An agent that is not on this machine is not a problem, and this is the
    // one place that decides it. pew2 ships thirteen manifests and nobody
    // installs thirteen agents, so treating absence as a finding meant a normal
    // laptop reported eight warnings and advised deleting the manifests that
    // make those agents installable later. The catalogue of what you could add
    // is `pew2 providers list`; this command is only about what is broken.
    if (provider.commandMissing) continue;

    problems.push({
      id: "provider-missing-env",
      severity: "warning",
      provider: provider.manifest.id,
      detail: `${provider.manifest.name} needs ${provider.missingEnv.join(", ")}.`,
      // No ellipsis character here: `fix` is rendered on screens that fall back
      // to ASCII, and it is also the field an agent reads to decide what to run.
      // A placeholder glyph is unhelpful in both places.
      fix: `Set ${provider.missingEnv.join(" and ")} in the environment where the daemon runs`,
    });
  }

  const url = daemonUrl(env);
  const reachable = await (options.probeDaemon ?? defaultProbe)(url);
  const service = await (options.service ?? serviceStatus)();

  if (!reachable) {
    // A service that launchd holds *installed* while nothing answers is not the
    // same problem as no daemon at all: it is one that starts and dies, and
    // launchd's `KeepAlive` hides the loop by restarting it for ever. That is
    // the state every binary install was in — the plist named `pew2 run
    // /$bunfs/server.ts`, pew2 printed its help and exited 1, and doctor said
    // only "nothing serving", which reads as "not started yet".
    const crashLooping = service.state === "installed" && service.lastExitCode !== 0;
    problems.push({
      id: "daemon-unreachable",
      severity: "error",
      detail: crashLooping
        ? `The daemon service is installed but keeps exiting (last exit code ${service.lastExitCode}). Nothing is serving on ${url}.`
        : `Nothing serving on ${url}.`,
      // Reinstalling rewrites the plist, which is exactly what repairs a bad
      // one. The old fix named a path inside a source checkout — advice nobody
      // who installed a binary could follow.
      fix: crashLooping ? "pew2 service install" : daemonStartCommand(),
    });
  }

  // Starting the daemon mints a token, so an unreachable daemon already implies
  // this and repeating it would give an agent two fixes for one cause.
  if (reachable && !(await (options.pairing ?? readPairing)(env))?.token) {
    // `PEW2_TOKEN` wins over anything on disk, so when it is set and unusable,
    // "run pew2 pair" is advice that cannot work — the minted token would be
    // ignored in favour of the env var that caused this.
    const weakEnvToken =
      env.PEW2_TOKEN !== undefined && env.PEW2_TOKEN.length < MIN_TOKEN_LENGTH;
    problems.push({
      id: "not-paired",
      severity: "error",
      detail: weakEnvToken
        ? `PEW2_TOKEN is ${env.PEW2_TOKEN?.length} characters; it is the encryption key's only entropy and must be at least ${MIN_TOKEN_LENGTH}.`
        : "No pairing token.",
      fix: weakEnvToken ? "export PEW2_TOKEN=$(openssl rand -hex 32)" : "pew2 pair",
    });
  }

  const autostart = service.state === "running" || service.state === "installed";
  // Only worth raising once the daemon is actually up: before that,
  // `daemon-unreachable` is the more useful thing to say.
  if (reachable && !autostart && service.state !== "unsupported") {
    problems.push({
      id: "not-autostarted",
      severity: "warning",
      detail: "Daemon will not restart after a reboot.",
      fix: "pew2 service install",
    });
  }

  const stored = await (options.pairing ?? readPairing)(env);
  const token = stored?.token;
  const key = stored?.key;
  const relay = stored?.relay;

  const addresses = (options.addresses ?? lanAddresses)();
  // Only fatal without a relay: with one, the daemon dials out and a LAN
  // address is irrelevant.
  if (addresses.length === 0 && !relay) {
    problems.push({
      id: "no-lan-address",
      severity: "error",
      detail: "No network address and no relay. Nothing can reach this machine.",
      fix: "Connect to Wi-Fi, or run: pew2 relay <url>",
    });
  }

  if (!relay) {
    problems.push({
      id: "local-only",
      severity: "warning",
      detail: "No relay. Works on the same network only.",
      fix: "pew2 relay wss://your-relay.workers.dev",
    });
  }

  return {
    ok: !problems.some((p) => p.severity === "error"),
    providerDirs: dirs,
    providers: providers.map((p) => ({
      id: p.manifest.id,
      available: isAvailable(p),
      source: p.source,
      reason: unavailableReason(p),
    })),
    daemon: { url, reachable, autostart },
    pairing: {
      url:
        token && (relay || addresses[0])
          ? pairingUrl({ token, key, port: daemonPort(env), host: addresses[0], relay })
          : undefined,
      addresses,
      relay,
      remote: Boolean(relay),
    },
    problems,
  };
}
