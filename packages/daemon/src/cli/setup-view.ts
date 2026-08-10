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
  /**
   * Turned off by the user.
   *
   * Kept separate from every other state because it is the only one that is a
   * choice rather than a condition: the agent works fine, it is simply not
   * wanted. Grouping it under "not working" would read as a fault report.
   */
  disabled?: boolean;
  /**
   * A test fixture rather than a real agent.
   *
   * The daemon never announces these to the phone, so any screen that offers a
   * choice must leave them out \u2014 picking one would promise an agent that never
   * appears.
   */
  experimental?: boolean;
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

/**
 * What went wrong, in words a person can act on.
 *
 * The broken section used to print the agent's raw failure under the heading
 * "Not working", which answers none of the three questions someone actually has:
 * is it me, is it the agent, or is it pew2? "'Gemini CLI' failed to start: ACP
 * connection closed. It was started with: npx …" reads as pew2 being broken, and
 * the one useful line — what the process printed on its way out — was on the
 * *second* line of the message, which this screen drops.
 *
 * So a failure is sorted into the small number of things it can actually be,
 * each with a fixed sentence, and the agent's own words are kept as evidence
 * underneath rather than used as the explanation.
 */
export type FailureKind = "outdated" | "stalled" | "crashed" | "unknown";

export interface Failure {
  kind: FailureKind;
  /** Two or three words, shown beside the agent's name. */
  label: string;
  /** One sentence: what happened, and what it means. */
  explain: string;
  /** The agent's own words, when they say more than the sentence does. */
  evidence?: string;
}

/** The agent does not speak ACP — almost always a version from before it did. */
const OUTDATED =
  /method not found|-32601|unknown (?:option|argument|flag|command)|unrecognized (?:option|argument)|invalid option|unsupported protocol|protocol version/i;

/**
 * It never answered. Distinct from crashing: the process is alive, just mute.
 *
 * "never opened a session" is the same condition one step later — the agent
 * answered the handshake and then went quiet on `session/new` — so it reads as
 * the same thing to the user and must not fall through to "did not start",
 * which would be a lie about an agent that plainly did.
 */
const STALLED =
  /did not respond to the acp handshake|never opened a session|timed out|timeout/i;

/** It answered with an exit rather than a handshake. */
const CRASHED =
  /failed to start|connection closed|exited|not found on path|eacces|spawn \w+/i;

/** Wrapper text that says nothing on its own, so it must not be shown as a reason. */
const EMPTY_REASON =
  /^(?:acp )?connection closed$|^internal error$|^the agent failed without saying why$/i;

/**
 * The agent's message with pew2's own framing taken back off.
 *
 * `connect.ts` wraps every failure as "'Name' failed to start: <message>. It was
 * started with: <command>" so a log line is attributable to something. On this
 * screen the name is already the row and the command is already known, so both
 * are noise around the only part worth reading.
 */
function coreMessage(detail: string): string {
  const first = detail.split("\n")[0]!.trim();
  return first
    .replace(/^'[^']*'\s+(?:failed to start:\s*)?/i, "")
    .replace(/\s*It was started with:.*$/i, "")
    .replace(/[.\s]+$/, "")
    .trim();
}

/**
 * What the process printed before dying.
 *
 * `failureContext()` in `connect.ts` appends the captured stderr after a
 * newline, and `wrapDetail` keeps only the first line — so the single most
 * useful thing about a crash (`npm error 404`, `Node 20 or later is required`)
 * was being collected by the daemon and then dropped by the renderer.
 */
function stderrLine(detail: string): string | undefined {
  for (const line of detail.split("\n").slice(1)) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

/** Classify a broken agent's failure. Only meaningful for the `broken` bucket. */
export function failureFor(agent: AgentState): Failure {
  const detail = agent.verify?.detail ?? "";
  const reason = coreMessage(detail);
  const printed = stderrLine(detail);
  const said = reason && !EMPTY_REASON.test(reason) ? reason : undefined;

  // Order matters: the wrapper says "failed to start" for every one of these, so
  // the specific causes have to be tested before the generic crash.
  if (OUTDATED.test(detail)) {
    return {
      kind: "outdated",
      label: "too old",
      explain:
        "This version does not speak ACP, the protocol pew2 drives it with. Update the agent, then run pew2 setup again.",
      evidence: said ?? printed,
    };
  }

  if (STALLED.test(detail)) {
    return {
      kind: "stalled",
      label: "no answer",
      // Said plainly because it is usually not a fault at all: the first run of
      // an npx-launched agent downloads the package, and on a slow connection
      // that can outlast the check.
      explain:
        "It started but never finished connecting. A first run downloads the agent, so this often passes on a second try.",
      evidence: printed,
    };
  }

  if (CRASHED.test(detail)) {
    return {
      kind: "crashed",
      label: "quit at startup",
      explain: "The agent started, then exited before pew2 could connect to it.",
      // Its own words first — "connection closed" is only pew2 noticing the
      // exit, so where that is all there is, what it printed is the whole story.
      evidence: said ?? printed,
    };
  }

  return {
    kind: "unknown",
    label: "did not start",
    explain:
      said ??
      "The agent stopped without saying why. Running it once in a terminal usually shows the reason.",
    evidence: said ? printed : undefined,
  };
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
 * The parenthetical after an agent's name in the picker.
 *
 * A couple of words on why a row is not ready — never a verdict. It used to say
 * "not working" for every failed verification, which lumped an agent that has
 * merely not been signed into yet with one that genuinely crashed, and told
 * three of the agents on a normal machine they were broken when the only thing
 * missing was a login.
 *
 * Sorted by the same bucket the report below uses, so the picker and the
 * sections printed under it can no longer disagree about what state an agent is
 * in — which they did, since one read `verify.status` directly and the other did
 * not.
 */
export function pickerNote(agent: AgentState): string | undefined {
  switch (bucketFor(agent)) {
    case "not-installed":
      return "not installed";
    case "needs-setup":
      return "needs signing in";
    case "missing-key":
      return agent.missingEnv.length > 0 ? `needs ${agent.missingEnv[0]}` : "needs a key";
    case "broken":
      return failureFor(agent).label;
    default:
      return undefined;
  }
}

/**
 * Can this agent be turned on for the phone?
 *
 * Installed and startable is the bar — not signed in. Logging in is a
 * thirty-second job someone may well do straight after this screen, and
 * refusing to let them select it meant setup wrote the agent into the disabled
 * list on their behalf: an agent they authenticated an hour later stayed hidden
 * from the phone until they found `pew2 providers enable`.
 */
export function canPick(agent: AgentState): boolean {
  const bucket = bucketFor(agent);
  return bucket !== "not-installed" && bucket !== "broken";
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
  // Turned-off agents are pulled out before bucketing.
  //
  // Since setup stopped starting them, they have no verification behind them —
  // and `bucketFor` reads "no report" as ready, so they would take a green tick
  // under "Ready to use" that nothing on this run actually checked. Worse, it
  // contradicts the closing count, which has always counted only what the phone
  // gets: five ticks above "2 agents ready" reads as a bug in the count.
  const off = agents.filter((agent) => agent.disabled);
  const buckets = group(agents.filter((agent) => !agent.disabled));
  const out: string[] = [];

  if (buckets.ready.length > 0) {
    out.push(...r.step("Ready to use", plural(buckets.ready.length, "agent")));
    for (const agent of buckets.ready) {
      out.push(r.line(`${s.hex(PALETTE.success, g.tick)} ${agent.name}`));
    }
  }

  if (off.length > 0) {
    // Stated as the user's own decision, with the way back. Not a fault, not a
    // chore, and never checked — starting an agent someone has switched off is
    // the thing that made this section necessary.
    out.push(...r.step("Turned off", "your choice — not checked"));
    out.push(
      r.line(
        `${s.hex(PALETTE.faint, off.map((agent) => agent.name).sort((a, b) => a.localeCompare(b)).join(", "))}`,
      ),
    );
    out.push(
      r.line(
        `${s.hex(PALETTE.faint, "pew2 providers enable <id>")}   ${s.hex(PALETTE.faint, "to use one again")}`,
      ),
    );
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
    //
    // The heading names the agent as the subject, not the verdict: "Not working"
    // above a pew2 screen reads as pew2 not working, which is the opposite of
    // what happened — the check ran fine and found something on this computer.
    out.push(...r.step("Installed, but not starting", "what each one did"));
    for (const agent of buckets.broken) {
      const failure = failureFor(agent);
      out.push(
        r.line(
          `${s.hex(PALETTE.danger, g.cross)} ${s.bold(agent.name)}${s.hex(PALETTE.faint, `  ${failure.label}`)}`,
        ),
      );
      for (const part of wrapDetail(failure.explain, detailWidth(options))) {
        out.push(r.line(`  ${s.hex(PALETTE.faint, part)}`));
      }
      if (failure.evidence) {
        // Quoted, so it is obvious which words are the agent's and which are
        // ours. Without that, a cryptic `npm error 404` reads as pew2's own.
        for (const part of wrapDetail(`"${failure.evidence}"`, detailWidth(options))) {
          out.push(r.line(`  ${s.hex(PALETTE.faint, part)}`));
        }
      }
      // For an outdated agent the useful command is the one that updates it;
      // for anything else it is the one that shows the failure in full.
      const next =
        failure.kind === "outdated" && agent.install
          ? agent.install
          : `pew2 providers verify ${agent.id}`;
      out.push(r.line(`  ${s.hex(PALETTE.faint, next)}`));
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
 *
 * The count is of agents the phone will actually be offered, not of agents that
 * work. Those are different numbers the moment someone deselects one in the
 * picker, and printing the second under a picker that just said the first read
 * as the tool ignoring the choice — "2 agents on your phone" directly above
 * "4 agents ready".
 *
 * Test fixtures are excluded for the same reason they are kept out of the
 * picker and off the wire: the phone never sees them. Counting one would be a
 * number the user cannot act on, since an agent the picker never offered is
 * also one they can never turn off.
 */
export function outroFor(
  agents: AgentState[],
  ready: boolean,
  options: RenderOptions = {},
  disabled: ReadonlySet<string> = new Set(),
): string[] {
  const s = options.style ?? styler();
  const r = rail(options);
  const usable = group(agents).ready.filter((agent) => !agent.experimental);
  const count = usable.filter((agent) => !disabled.has(agent.id)).length;

  if (count === 0) {
    // Having none selected is a choice, not an empty machine. Telling someone
    // who just deselected everything to go and install an agent would be
    // answering a question they did not ask.
    if (usable.length > 0) {
      return r.outro(
        `${s.bold("No agents selected.")} ${s.hex(PALETTE.faint, "Run")} ${s.bold("pew2 setup")} ${s.hex(PALETTE.faint, "again to choose the ones your phone can use.")}`,
      );
    }
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

  const off = agents.filter((a) => a.disabled).sort((a, b) => a.name.localeCompare(b.name));
  const on = (list: AgentState[]) => list.filter((a) => !a.disabled);

  const ready = on(buckets.ready);
  if (ready.length > 0) {
    out.push(...r.step("Ready to use", plural(ready.length, "agent")));
    rows(ready, s.hex(PALETTE.success, g.tick));
  }

  const half = on([...buckets["needs-setup"], ...buckets["missing-key"]]).sort((a, b) =>
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

  const broken = on(buckets.broken);
  if (broken.length > 0) {
    out.push(...r.step("Installed, but not starting", "one line on what happened"));
    for (const agent of broken) {
      const failure = failureFor(agent);
      out.push(
        r.line(
          `${s.hex(PALETTE.danger, g.cross)} ${s.bold(agent.name)}${s.hex(PALETTE.faint, `  ${failure.label}`)}`,
        ),
      );
      // A catalogue, so one sentence each and no evidence dump: the screen that
      // exists to explain a single failure is `pew2 providers verify <id>`.
      for (const part of wrapDetail(failure.explain, width - 2)) {
        out.push(r.line(`  ${s.hex(PALETTE.faint, part)}`));
      }
    }
  }

  if (off.length > 0) {
    // Last, and phrased as a choice. These are working agents the user has
    // chosen not to see on their phone, so the row says how to undo it rather
    // than implying something is wrong with them.
    out.push(...r.step("Turned off", plural(off.length, "agent")));
    for (const agent of off) {
      out.push(r.line(`${s.hex(PALETTE.faint, g.dot)} ${s.hex(PALETTE.faint, agent.name)}`));
    }
    out.push(
      r.line(
        `  ${s.hex(PALETTE.faint, "Show one again with")} ${s.bold("pew2 providers enable <id>")}`,
      ),
    );
  }

  if (on(buckets["not-installed"]).length > 0) {
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
