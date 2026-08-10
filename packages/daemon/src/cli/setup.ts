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
import { readDisabled, retireLegacyDisabled } from "../providers/enabled.js";
import { doctor, type DoctorReport } from "./doctor.js";
import { CATALOG } from "../providers/detect.js";
import type { AgentState } from "./setup-view.js";

export interface SetupResult {
  /** True when nothing blocking remains. The agent's stop condition. */
  ok: boolean;
  detect: DetectResult;
  /** Empty when verification was skipped. */
  verify: VerifyReport[];
  doctor: DoctorReport;
  /**
   * Every agent pew2 knows about, and what state it is in on this machine.
   *
   * The presentation layer groups these; assembling the list here keeps the
   * command from having to re-derive it from three separate result shapes.
   */
  agents: AgentState[];
  /** Commands to run next, in order. Empty when setup is complete. */
  nextSteps: string[];
  /**
   * Agents turned back on by retiring a version 1 `disabled.json`.
   *
   * Reported rather than done quietly: an earlier setup wrote agents into that
   * file on the user's behalf whenever a check failed, so the list cannot be
   * read as their decision. Undoing it silently would be the same mistake in
   * the other direction — they get told, once, and choose again.
   */
  restored: string[];
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
  /**
   * Run verification. Injectable so a test can describe a mix of working and
   * unconfigured agents without spawning any, which is the only way to cover
   * the rule that one working agent is enough.
   */
  verifyProviders?: typeof verifyAll;
  onProgress?: (stage: "detect" | "verify" | "doctor", note?: string) => void;
}

export async function setup(options: SetupOptions = {}): Promise<SetupResult> {
  const env = options.env ?? process.env;
  const progress = options.onProgress ?? (() => {});
  const searchDirs = options.searchDirs ?? providerDirs(env);
  // The built-in agents come from the array compiled into this binary, and are
  // included only when the caller did not name its own directories — a test
  // pointing at a sandbox means that sandbox and nothing else.
  const bundled = options.searchDirs === undefined;

  progress("detect");
  const detected = await detectProviders({ env, searchDirs, targetDir: searchDirs[0] });

  // Agents the user has explicitly turned off.
  //
  // Verification is not a read: it starts the agent for real. Checking one that
  // has been switched off means spawning a process on someone's machine, on
  // every run of setup, for an agent they have already said they do not want —
  // and then reporting on it, which invites them to fix something they were
  // never going to use.
  //
  // Only what is *already* off, so the first run still checks everything: that
  // is the run whose whole purpose is to find out what works.
  //
  // Retired first, so a list this tool wrote on the user's behalf is not then
  // used as grounds for skipping the very agents it wrongly recorded.
  const restored = await retireLegacyDisabled(env);
  const disabled = await readDisabled(env);

  let verify: VerifyReport[] = [];
  if (options.verify !== false) {
    const { providers } = await loadProviders(searchDirs, env, { bundled });
    // Only verify what could possibly run. Spawning a provider whose command is
    // missing produces a failure that says nothing `doctor` has not already said
    // more precisely.
    const runnable = providers.filter(
      (p) =>
        isAvailable(p) &&
        p.manifest.pew.transport === "acp" &&
        !disabled.has(p.manifest.id),
    );
    for (const provider of runnable) progress("verify", provider.manifest.id);
    verify = await (options.verifyProviders ?? verifyAll)(runnable);
  }

  progress("doctor");
  const report = await doctor({
    env,
    searchDirs,
    probeDaemon: options.probeDaemon,
    pairing: options.pairing,
    service: options.service,
  });

  // Agents are alternatives, not requirements.
  //
  // Nobody signs in to all thirteen: you use the one or two you pay for, and the
  // rest sit there unconfigured forever. Treating an unconfigured agent as a
  // failure made `pew2 setup` exit non-zero on a machine that was completely
  // working, which is both wrong and the thing that makes people think they have
  // broken something.
  //
  // So: setup succeeds when at least one agent can actually run. Everything else
  // is an option the user has not taken.
  const brokenProviders = verify.filter((r) => r.status === "failed");

  // Verification is the strong signal, but it is skippable. With `--skip-verify`
  // there are no reports at all, and treating that as "nothing works" would make
  // the fast path permanently report failure — so fall back to what the registry
  // can see: an agent that is installed and has the environment it declared.
  const usable =
    verify.length > 0
      ? verify.some((r) => r.status === "ok")
      : (await loadProviders(searchDirs, env, { bundled })).providers.some(isAvailable);

  const ok = report.ok && usable;

  const nextSteps: string[] = [];
  if (!ok) {
    for (const problem of report.problems) {
      if (problem.severity === "error" && !nextSteps.includes(problem.fix)) {
        nextSteps.push(problem.fix);
      }
    }
    // Only worth suggesting when nothing works at all. With a working agent in
    // hand, these are optional extras and listing them as "next steps" reads as
    // a list of chores.
    if (!usable) {
      for (const broken of brokenProviders) {
        nextSteps.push(`pew2 providers verify ${broken.id}   # ${broken.detail ?? "failed"}`);
      }
    }
  }

  // One row per agent, from the three sources that each know part of it: the
  // registry knows what is installed, verification knows what actually ran, and
  // the catalog knows where to get the rest.
  const { providers: allProviders } = await loadProviders(searchDirs, env, { bundled });
  const verifyById = new Map(verify.map((r) => [r.id, r]));
  const installById = new Map(CATALOG.map((c) => [c.manifest.id, c.install]));

  const agents: AgentState[] = allProviders.map((provider) => {
    const report = verifyById.get(provider.manifest.id);
    return {
      id: provider.manifest.id,
      name: provider.manifest.name,
      experimental: provider.manifest.pew.experimental,
      install: installById.get(provider.manifest.id),
      command: provider.command,
      missingEnv: provider.missingEnv,
      notInstalled: provider.commandMissing,
      // Carried so the screen can say "off" rather than silently showing an
      // agent as untested — which is what a skipped verification looks like.
      disabled: disabled.has(provider.manifest.id),
      verify: report
        ? { status: report.status, detail: report.detail }
        : undefined,
    };
  });

  return { ok, detect: detected, verify, doctor: report, agents, nextSteps, restored };
}
