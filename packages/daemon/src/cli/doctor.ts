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
import { lanAddresses, pairingFromToken, pairingPath, pairingUrl } from "../pairing.js";
import { serviceStatus } from "./service.js";
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
  if (env.PEW2_TOKEN) return { ...pairingFromToken(env.PEW2_TOKEN), relay: env.PEW2_RELAY };
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
    | "provider-unavailable"
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

export interface DoctorOptions {
  env?: NodeJS.ProcessEnv;
  /** Directories scanned for manifests. Defaults to `providerDirs(env)`. */
  searchDirs?: string[];
  /** Injectable so tests never depend on a real socket. */
  probeDaemon?: (url: string) => Promise<boolean>;
  /** Injectable so tests never depend on the host's real network interfaces. */
  addresses?: () => string[];
  /** Injectable so tests never inspect the real launchd domain. */
  service?: () => Promise<{ state: string }>;
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
  const { providers, errors } = await loadProviders(dirs, env);
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

    if (provider.commandMissing) {
      problems.push({
        id: "provider-unavailable",
        severity: "warning",
        provider: provider.manifest.id,
        detail: `'${provider.command}' not on PATH. ${provider.manifest.name} cannot start.`,
        fix: `Install ${provider.manifest.name}, or delete ${provider.source}`,
      });
      continue;
    }

    problems.push({
      id: "provider-missing-env",
      severity: "warning",
      provider: provider.manifest.id,
      detail: `${provider.manifest.name} needs ${provider.missingEnv.join(", ")}.`,
      fix: `Set ${provider.missingEnv.map((n) => `${n}=…`).join(" and ")} where the daemon runs`,
    });
  }

  const url = daemonUrl(env);
  const reachable = await (options.probeDaemon ?? defaultProbe)(url);
  if (!reachable) {
    problems.push({
      id: "daemon-unreachable",
      severity: "error",
      detail: `Nothing serving on ${url}.`,
      fix: "PEW2_EXPERIMENTAL=1 bun run packages/daemon/src/server.ts",
    });
  }

  // Starting the daemon mints a token, so an unreachable daemon already implies
  // this and repeating it would give an agent two fixes for one cause.
  if (reachable && !(await (options.pairing ?? readPairing)(env))?.token) {
    problems.push({
      id: "not-paired",
      severity: "error",
      detail: "No pairing token.",
      fix: "pew2 pair",
    });
  }

  const service = await (options.service ?? serviceStatus)();
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
