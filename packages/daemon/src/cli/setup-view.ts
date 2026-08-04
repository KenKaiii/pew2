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
import { PALETTE, styler, glyphs, type Glyphs, type Style } from "./ui.js";

/** What we know about one agent after looking at the machine. */
export interface AgentState {
  id: string;
  name: string;
  /** Where to get it, for the ones that are not here yet. */
  install?: string;
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
 * `signin` is split out from `broken` deliberately. "Run `qwen` to log in" is a
 * thirty-second fix the user can act on; "Internal error" is not, and mixing
 * them makes both look equally hopeless.
 */
export type Bucket = "ready" | "signin" | "missing-key" | "not-installed" | "broken";

/**
 * Does this failure mean "you have not logged in yet"?
 *
 * Agents word this differently and none of them use a machine-readable code, so
 * matching on the text is the only option. Being wrong is cheap in one
 * direction and not the other: calling a real breakage a sign-in problem sends
 * someone to run a login command that works fine and leaves them stuck, so the
 * patterns stay narrow rather than clever.
 */
export function isAuthFailure(detail: string | undefined): boolean {
  if (!detail) return false;
  return /\bauthenticat|\blog ?in\b|\bsign ?in\b|not logged in|unauthori[sz]ed|api[- ]?key/i.test(
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
    return isAuthFailure(agent.verify.detail) ? "signin" : "broken";
  }
  return "ready";
}

export function group(agents: AgentState[]): Record<Bucket, AgentState[]> {
  const out: Record<Bucket, AgentState[]> = {
    ready: [],
    signin: [],
    "missing-key": [],
    "not-installed": [],
    broken: [],
  };
  for (const agent of agents) out[bucketFor(agent)].push(agent);
  for (const list of Object.values(out)) list.sort((a, b) => a.name.localeCompare(b.name));
  return out;
}

export interface RenderOptions {
  style?: Style;
  glyph?: Glyphs;
}

/**
 * The vertical rail.
 *
 * Borrowed from the visual language `@clack/prompts` popularised, because it
 * solves the actual problem: it makes a sequence of steps read as one connected
 * flow rather than as unrelated blocks of text scrolling past. Implemented here
 * rather than taken as a dependency, since this ships inside a compiled binary
 * and `ui.ts` already degrades colour and glyphs correctly for terminals that
 * cannot render either.
 */
interface Rail {
  /** Opens the flow. */
  intro: (title: string, subtitle?: string) => string[];
  /** A section heading hanging off the rail. */
  step: (title: string, note?: string) => string[];
  /** A line inside the current section. */
  line: (text: string) => string;
  /** An empty rail segment, for breathing room. */
  bar: () => string;
  /** Closes the flow. */
  outro: (text: string) => string[];
}

export function rail(options: RenderOptions = {}): Rail {
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  const unicode = g.unicode;

  const pipe = s.hex(PALETTE.faint, unicode ? "│" : "|");
  const open = s.hex(PALETTE.accent, unicode ? "◆" : "*");
  const dot = s.hex(PALETTE.faint, unicode ? "◇" : "o");
  const end = s.hex(PALETTE.accent, unicode ? "└" : "`");

  return {
    intro: (title, subtitle) => [
      "",
      `${open}  ${s.bold(title)}`,
      ...(subtitle ? [`${pipe}  ${s.hex(PALETTE.faint, subtitle)}`] : []),
    ],
    step: (title, note) => [
      pipe,
      `${dot}  ${s.bold(title)}${note ? s.hex(PALETTE.faint, `  ${note}`) : ""}`,
      pipe,
    ],
    line: (text) => `${pipe}  ${text}`,
    bar: () => pipe,
    outro: (text) => [pipe, `${end}  ${text}`, ""],
  };
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

  if (buckets.signin.length > 0) {
    // Not an error, and worded as the small thing it is.
    out.push(...r.step("Just needs a sign-in", "one command each, then you are set"));
    for (const agent of buckets.signin) {
      out.push(r.line(`${s.hex(PALETTE.warning, g.dot)} ${s.bold(agent.name)}`));
      out.push(r.line(`  ${s.hex(PALETTE.faint, signinHint(agent))}`));
    }
  }

  if (buckets["missing-key"].length > 0) {
    out.push(...r.step("Needs an API key", "set it where the daemon runs"));
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
      if (detail) out.push(r.line(`  ${s.hex(PALETTE.faint, firstLine(detail))}`));
      out.push(r.line(`  ${s.hex(PALETTE.faint, `pew2 providers verify ${agent.id}`)}`));
    }
  }

  if (buckets["not-installed"].length > 0) {
    // One line, no marks, no colour beyond dim. You are not missing anything by
    // not having these, and the screen should not imply that you are.
    out.push(...r.step("Also available", "not on this computer"));
    out.push(r.line(s.hex(PALETTE.faint, buckets["not-installed"].map((a) => a.name).join(", "))));
    out.push(r.line(s.hex(PALETTE.faint, "pew2 providers list   shows how to add any of them")));
  }

  return out;
}

/** What to run to log this agent in. Falls back to the agent's own command. */
function signinHint(agent: AgentState): string {
  return agent.install ? `run  ${agent.install}` : `run  ${agent.id}  once to sign in`;
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
  if (!ready) {
    return r.outro(
      `${s.bold(`${plural(count, "agent")} ready.`)} ${s.hex(PALETTE.faint, "Finish the steps above, then run")} ${s.bold("pew2 setup")}`,
    );
  }
  return r.outro(
    `${s.bold(`${plural(count, "agent")} ready.`)} ${s.hex(PALETTE.faint, "Run")} ${s.bold("pew2 pair")} ${s.hex(PALETTE.faint, "to connect your phone.")}`,
  );
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Agents report multi-line stack traces; only the first line is readable here. */
function firstLine(text: string): string {
  const line = text.split("\n")[0]!.trim();
  return line.length > 72 ? `${line.slice(0, 71)}…` : line;
}
