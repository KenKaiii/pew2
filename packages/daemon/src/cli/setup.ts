/**
 * `pew2 setup` — the whole A-to-Z, in one call.
 *
 * The premise of pew2 is that a user asks the coding agent they already have to
 * connect their phone, and the agent does it. That only works if there is a
 * single entry point that is safe to run repeatedly, never destroys existing
 * configuration, and ends by saying — in machine-readable form — exactly what is
 * still wrong and what command fixes it.
 *
 * So setup is: detect what is installed, prove it really speaks ACP, then
 * diagnose. Each stage is a function elsewhere; this only sequences them.
 */
import { detectProviders, type DetectResult } from "../providers/detect.js";
import { verifyAll, type VerifyReport } from "../providers/verify.js";
import { loadProviders, providerDirs, isAvailable } from "../providers/registry.js";
import { doctor, type DoctorReport } from "./doctor.js";

export interface SetupResult {
  /** True when nothing blocking remains. The agent's stop condition. */
  ok: boolean;
  detect: DetectResult;
  /** Empty when verification was skipped. */
  verify: VerifyReport[];
  doctor: DoctorReport;
  /** Commands to run next, in order. Empty when setup is complete. */
  nextSteps: string[];
}

export interface SetupOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * Directories scanned for manifests, highest precedence first. New manifests
   * are written to the first one. Defaults to `providerDirs(env)`.
   */
  searchDirs?: string[];
  /**
   * Verification spawns every agent and prompts it for real, which costs
   * seconds and may hit the network. Skippable so a re-run after a small fix is
   * fast, but it is on by default: a manifest that has not been verified has
   * proven nothing.
   */
  verify?: boolean;
  probeDaemon?: (url: string) => Promise<boolean>;
  /** Read the stored pairing. Injectable so tests need no real home directory. */
  pairing?: (env: NodeJS.ProcessEnv) => Promise<{ token?: string; relay?: string } | undefined>;
  /** Read service state. Injectable so tests never inspect real launchd. */
  service?: () => Promise<{ state: string }>;
  onProgress?: (stage: "detect" | "verify" | "doctor", note?: string) => void;
}

export async function setup(options: SetupOptions = {}): Promise<SetupResult> {
  const env = options.env ?? process.env;
  const progress = options.onProgress ?? (() => {});
  const searchDirs = options.searchDirs ?? providerDirs(env);

  progress("detect");
  const detected = await detectProviders({ env, searchDirs, targetDir: searchDirs[0] });

  let verify: VerifyReport[] = [];
  if (options.verify !== false) {
    const { providers } = await loadProviders(searchDirs, env);
    // Only verify what could possibly run. Spawning a provider whose command is
    // missing produces a failure that says nothing `doctor` has not already said
    // more precisely.
    const runnable = providers.filter(
      (p) => isAvailable(p) && p.manifest.pew.transport === "acp",
    );
    for (const provider of runnable) progress("verify", provider.manifest.id);
    verify = await verifyAll(runnable);
  }

  progress("doctor");
  const report = await doctor({
    env,
    searchDirs,
    probeDaemon: options.probeDaemon,
    pairing: options.pairing,
    service: options.service,
  });

  // A provider that verified as failed is a blocking problem even though the
  // manifest itself is fine, so it is folded into the same decision `doctor`
  // makes rather than reported alongside it.
  const brokenProviders = verify.filter((r) => r.status === "failed");
  const ok = report.ok && brokenProviders.length === 0;

  const nextSteps: string[] = [];
  if (!ok) {
    for (const problem of report.problems) {
      if (problem.severity === "error" && !nextSteps.includes(problem.fix)) {
        nextSteps.push(problem.fix);
      }
    }
    for (const broken of brokenProviders) {
      nextSteps.push(`pew2 providers verify ${broken.id}   # ${broken.detail ?? "failed"}`);
    }
  }

  return { ok, detect: detected, verify, doctor: report, nextSteps };
}
