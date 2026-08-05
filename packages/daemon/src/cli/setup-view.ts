/**
 * What `pew2 setup` shows you.
 *
 * The old output printed everything it learned, in the order it learned it, with
 * a red cross next to every agent you had not installed. Someone who owns Claude
 * Code and nothing else saw five failures and three errors, and reasonably
 * concluded the thing was broken. It was not. It was describing a normal
 * machine in the language of a crash report.
 *
 * So the rule here: **not installed is not a failure.** It is a fact about the
 * computer, and most people will never install more than one or two agents.
 * Only something the user must act on to make pew2 work gets a warning colour,
 * and nothing at all gets a red cross unless it is genuinely broken.
 *
 * Rendering is separated from doing so the whole screen can be tested without
 * spawning a single agent. Every function takes plain data and returns lines.
 */
import { PALETTE, styler, glyphs } from "./ui.js";
import { rail, plural, wrapDetail, detailWidth, type RenderOptions } from "./rail.js";

// The type travels with the render functions below, since callers need it to
// build the options they pass in. The rail itself is imported from `rail.js`.
export type { RenderOptions };

/** What we know about one agent after looking at the machine. */
export interface AgentState {
  id: string;
  name: string;
  /** Where to get it, for the ones that are not here yet. */
  install?: string;
  /**
   * One short line about what this agent is.
   *
   * Shown by `pew2 providers list`, which is a catalogue. Setup does not use it:
   * there the question is "does it work", and a description would bury that.
   */
  summary?: string;
  /**
   * The executable this agent runs as.
   *
   * Only useful as a sign-in hint when it is the agent itself. Most manifests
   * launch through `npx`, where this is literally "npx" and tells nobody
   * anything.
   */
  command?: string;
  /** Missing required environment variables, if any. */
  missingEnv: string[];
  /** True when the command is not on PATH. */
  notInstalled: boolean;
  /** Verification outcome, absent when it was not attempted. */
  verify?: { status: "ok" | "failed" | "skipped"; detail?: string };
}

/**
 * The four things an agent can be, in the order a person cares about.
 *
 * `needs-setup` is split out from `broken` deliberately. "Run `qwen` to log in"
 * is a thirty-second fix the user can act on; a genuine crash is not, and mixing
 * them makes both look equally hopeless.
 */
export type Bucket = "ready" | "needs-setup" | "missing-key" | "not-installed" | "broken";

/**
 * Is this a "you have not finished setting it up yet" failure?
 *
 * Covers signing in and configuring, because to the person reading the screen
 * they are the same thing: one command away from working. goose saying
 * "Configuration value not found: GOOSE_PROVIDER" is no more a crash than Qwen
 * saying "authenticate first".
 *
 * Agents word these differently and none use a machine-readable code, so
 * matching on text is the only option. Being wrong is cheap in one direction
 * and not the other: calling a real breakage a setup step sends someone to run
 * a command that works fine and leaves them stuck. So the patterns stay narrow.
 */
export function needsSetup(detail: string | undefined): boolean {
  if (!detail) return false;
  return /\bauthenticat|\blog ?in\b|\bsign ?in\b|not logged in|unauthori[sz]ed|api[- ]?key|configuration value not found|not configured|no provider configured|missing configuration|run .*configure/i.test(
    detail,
  );
}

/** Sort one agent into its bucket. */
export function bucketFor(agent: AgentState): Bucket {
  // Checked first: an agent that is not on the machine cannot have an auth
  // problem, and saying it does would be nonsense.
  if (agent.notInstalled) return "not-installed";
  if (agent.missingEnv.length > 0) return "missing-key";
  if (agent.verify?.status === "failed") {
    return needsSetup(agent.verify.detail) ? "needs-setup" : "broken";
  }
  return "ready";
}

export function group(agents: AgentState[]): Record<Bucket, AgentState[]> {
  const out: Record<Bucket, AgentState[]> = {
    ready: [],
    "needs-setup": [],
    "missing-key": [],
    "not-installed": [],
    broken: [],
  };
  for (const agent of agents) out[bucketFor(agent)].push(agent);
  for (const list of Object.values(out)) list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

/**
 * The agent sections.
 *
 * Order matters and is not alphabetical: what works comes first, because that is
 * the answer to "did this do anything". What needs a small action comes next.
 * What is simply absent comes last and is deliberately compressed onto one line,
 * since a list of things you do not have should not be the biggest thing on the
 * screen.
 */
export function agentSections(agents: AgentState[], options: RenderOptions = {}): string[] {
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  const r = rail(options);
  const buckets = group(agents);
  const out: string[] = [];

  if (buckets.ready.length > 0) {
    out.push(...r.step("Ready to use", plural(buckets.ready.length, "agent")));
    for (const agent of buckets.ready) {
      out.push(r.line(`${s.hex(PALETTE.success, g.tick)} ${agent.name}`));
    }
  }

  if (buckets["needs-setup"].length > 0) {
    // Not an error, and worded as the small thing it is.
    out.push(...r.step("Available if you want them", "installed, but not signed in"));
    for (const agent of buckets["needs-setup"]) {
      out.push(r.line(`${s.hex(PALETTE.warning, g.dot)} ${s.bold(agent.name)}`));
      for (const part of wrapDetail(signinHint(agent), detailWidth(options))) {
        out.push(r.line(`  ${s.hex(PALETTE.faint, part)}`));
      }
    }
  }

  if (buckets["missing-key"].length > 0) {
    out.push(...r.step("Available with a key", "set it where the daemon runs"));
    for (const agent of buckets["missing-key"]) {
      out.push(r.line(`${s.hex(PALETTE.warning, g.dot)} ${s.bold(agent.name)}`));
      out.push(r.line(`  ${s.hex(PALETTE.faint, `${agent.missingEnv.join(", ")}`)}`));
    }
  }

  if (buckets.broken.length > 0) {
    // The only section that gets a cross, and only for agents that are on the
    // machine and genuinely will not run.
    out.push(...r.step("Not working", "these are installed but would not start"));
    for (const agent of buckets.broken) {
      out.push(r.line(`${s.hex(PALETTE.danger, g.cross)} ${s.bold(agent.name)}`));
      const detail = agent.verify?.detail;
      if (detail) {
        for (const part of wrapDetail(detail, detailWidth(options))) {
          out.push(r.line(`  ${s.hex(PALETTE.faint, part)}`));
        }
      }
      out.push(r.line(`  ${s.hex(PALETTE.faint, `pew2 providers verify ${agent.id}`)}`));
    }
  }

  if (buckets["not-installed"].length > 0) {
    // One line, no marks, no colour beyond dim. You are not missing anything by
    // not having these, and the screen should not imply that you are.
    out.push(...r.step("Also available", "not on this computer"));
    // Wrapped: on a fresh machine every agent lands here, and thirteen names on
    // one line is 140 characters. That is the first screen a new user sees.
    const names = buckets["not-installed"].map((a) => a.name).join(", ");
    for (const part of wrapDetail(names, detailWidth(options))) {
      out.push(r.line(s.hex(PALETTE.faint, part)));
    }
    out.push(r.line(s.hex(PALETTE.faint, "pew2 providers list   shows how to add any of them")));
  }

  return out;
}

/**
 * What to tell someone whose agent is installed but not logged in.
 *
 * Deliberately not the install command: the agent is already here, so
 * "npm install -g ..." does nothing and reads as though the install failed.
 *
 * Also deliberately not a guessed binary name. Most manifests launch through
 * `npx`, so `command` is the string "npx", and the actual login binary varies
 * per agent in ways this cannot know — `claude` and `goose` are on PATH here,
 * `cline` and `qwen` are not. A confidently wrong command is worse than none.
 *
 * So: the agent's own message, which is the one thing that is always accurate,
 * and a pointer to where the real instructions live.
 */
function signinHint(agent: AgentState): string {
  const detail = agent.verify?.detail;
  return detail ? detail.split("\n")[0]!.trim() : "finish this agent's own setup, then run pew2 setup again";
}

/**
 * The closing line.
 *
 * Says the one thing the user came for: can I use this now, and what do I do
 * next. Never a count of problems.
 */
export function outroFor(
  agents: AgentState[],
  ready: boolean,
  options: RenderOptions = {},
): string[] {
  const s = options.style ?? styler();
  const r = rail(options);
  const count = group(agents).ready.length;

  if (count === 0) {
    return r.outro(
      `${s.bold("No agents yet.")} ${s.hex(PALETTE.faint, "Install one from the list above, then run")} ${s.bold("pew2 setup")} ${s.hex(PALETTE.faint, "again.")}`,
    );
  }
  // One working agent is the whole requirement. Anything else on the screen is
  // an option the user has not taken, so the closing line must not read as a
  // list of outstanding chores — nobody signs in to all thirteen.
  if (!ready) {
    return r.outro(
      `${s.bold(`${plural(count, "agent")} ready.`)} ${s.hex(PALETTE.faint, "Sort the machine out above, then run")} ${s.bold("pew2 setup")}`,
    );
  }
  return r.outro(
    `${s.bold(`${plural(count, "agent")} ready.`)} ${s.hex(PALETTE.faint, "That is all you need — run")} ${s.bold("pew2 pair")} ${s.hex(PALETTE.faint, "to connect your phone.")}`,
  );
}

/**
 * `pew2 providers list`, in the same visual language as `pew2 setup`.
 *
 * A different job to the setup screen, though: this is the catalogue. Setup
 * answers "am I ready", so it compresses the agents you do not have onto one
 * line. This answers "what could I use", so every agent gets a row with what it
 * is and how to get it.
 *
 * Same rail, same buckets, same rule about tone — an agent you have not
 * installed is an option, not a problem — so the two commands read as one tool.
 */
export function providerList(agents: AgentState[], options: RenderOptions = {}): string[] {
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  const r = rail(options);
  const buckets = group(agents);
  const width = detailWidth(options);
  const out: string[] = [];

  const rows = (list: AgentState[], mark: string) => {
    for (const agent of list) {
      out.push(r.line(`${mark} ${s.bold(agent.name)}`));
      if (agent.summary) {
        for (const part of wrapDetail(agent.summary, width - 2)) {
          out.push(r.line(`  ${s.hex(PALETTE.faint, part)}`));
        }
      }
    }
  };

  if (buckets.ready.length > 0) {
    out.push(...r.step("Ready to use", plural(buckets.ready.length, "agent")));
    rows(buckets.ready, s.hex(PALETTE.success, g.tick));
  }

  const half = [...buckets["needs-setup"], ...buckets["missing-key"]].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  if (half.length > 0) {
    out.push(...r.step("Installed, not finished", "one step each"));
    for (const agent of half) {
      out.push(r.line(`${s.hex(PALETTE.warning, g.dot)} ${s.bold(agent.name)}`));
      const note =
        agent.missingEnv.length > 0
          ? `needs ${agent.missingEnv.join(", ")}`
          : (agent.verify?.detail ?? "needs signing in");
      for (const part of wrapDetail(note, width - 2)) {
        out.push(r.line(`  ${s.hex(PALETTE.faint, part)}`));
      }
    }
  }

  if (buckets.broken.length > 0) {
    out.push(...r.step("Not working", "installed but would not start"));
    for (const agent of buckets.broken) {
      out.push(r.line(`${s.hex(PALETTE.danger, g.cross)} ${s.bold(agent.name)}`));
      const detail = agent.verify?.detail;
      if (detail) {
        for (const part of wrapDetail(detail, width - 2)) {
          out.push(r.line(`  ${s.hex(PALETTE.faint, part)}`));
        }
      }
    }
  }

  if (buckets["not-installed"].length > 0) {
    // Unlike the setup screen, these get a row each: the whole point of this
    // command is to answer "what else could I run", and a comma-separated list
    // cannot carry the install command that makes it actionable.
    out.push(...r.step("Available to install", plural(buckets["not-installed"].length, "agent")));
    for (const agent of buckets["not-installed"]) {
      out.push(r.line(`${s.hex(PALETTE.faint, g.dot)} ${s.bold(agent.name)}`));
      if (agent.install) {
        for (const part of wrapDetail(agent.install, width - 2)) {
          out.push(r.line(`  ${s.hex(PALETTE.faint, part)}`));
        }
      }
    }
  }

  return out;
}
