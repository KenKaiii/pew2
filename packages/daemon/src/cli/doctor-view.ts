/**
 * What `pew2 doctor` shows you.
 *
 * The old screen listed every agent, flagged the eight you had not installed,
 * then listed those same eight again underneath with a fix that suggested
 * deleting the manifest — and finished with "All good." A contradiction and a
 * scare in the same twenty lines.
 *
 * This screen answers one question: is anything wrong, and what do I do about
 * it. Working things collapse to a count, because "your daemon is fine" needs a
 * tick and not a paragraph. Only genuine problems get room, and each carries the
 * command that fixes it.
 */
import { PALETTE, styler, glyphs } from "./ui.js";
import { rail, plural, wrapDetail, detailWidth, type RenderOptions } from "./rail.js";
import type { DoctorReport, Problem } from "./doctor.js";

/**
 * A checked fact worth one line.
 *
 * Kept separate from problems so the screen can say "these four things are
 * fine" without turning each into a row someone has to read.
 */
export interface Check {
  label: string;
  ok: boolean;
  note?: string;
}

/** The facts, in the order they stop mattering if the previous one fails. */
export function checks(report: DoctorReport): Check[] {
  const ready = report.providers.filter((p) => p.available).length;
  return [
    {
      label: "Agents",
      ok: ready > 0,
      // plural() pluralises the last word, so it must be handed a noun and not
      // a phrase — "8 ready to runs" otherwise.
      note: ready > 0 ? `${plural(ready, "agent")} ready` : "none ready",
    },
    {
      label: "Service",
      ok: report.daemon.reachable,
      note: report.daemon.reachable ? report.daemon.url : "not running",
    },
    {
      label: "Starts on boot",
      ok: report.daemon.autostart,
      note: report.daemon.autostart ? "installed" : "not installed",
    },
    {
      label: "Reach",
      ok: report.pairing.remote,
      // The distinction the product lives on, so it is said in words rather
      // than left to a colour.
      note: report.pairing.remote ? "anywhere, via relay" : "same Wi-Fi only",
    },
  ];
}

/**
 * The closing line.
 *
 * Blocking problems are the only thing that can make this negative. A warning
 * means "you could do more", and a screen that shouts about optional things
 * teaches people to ignore it.
 */
export function summary(report: DoctorReport, options: RenderOptions = {}): string {
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  const errors = report.problems.filter((p) => p.severity === "error");
  const warnings = report.problems.filter((p) => p.severity === "warning");

  if (errors.length > 0) {
    return `${s.hex(PALETTE.danger, g.cross)} ${s.bold(`${plural(errors.length, "thing")} to fix.`)} ${s.hex(PALETTE.faint, "Each one has the command above.")}`;
  }
  if (warnings.length > 0) {
    return `${s.hex(PALETTE.success, g.tick)} ${s.bold("Working.")} ${s.hex(PALETTE.faint, `${plural(warnings.length, "optional improvement")} above.`)}`;
  }
  return `${s.hex(PALETTE.success, g.tick)} ${s.bold("Everything checks out.")}`;
}

function problemRows(
  title: string,
  note: string,
  problems: Problem[],
  colour: string,
  mark: string,
  options: RenderOptions,
): string[] {
  const s = options.style ?? styler();
  const r = rail(options);
  const out = [...r.step(title, note)];

  for (const problem of problems) {
    out.push(r.line(`${s.hex(colour, mark)} ${s.bold(problem.detail)}`));
    for (const part of wrapDetail(problem.fix, detailWidth(options) - 2)) {
      out.push(r.line(`  ${s.hex(PALETTE.faint, part)}`));
    }
  }
  return out;
}

/** The whole screen. */
export function doctorView(report: DoctorReport, options: RenderOptions = {}): string[] {
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  const r = rail(options);
  const errors = report.problems.filter((p) => p.severity === "error");
  const warnings = report.problems.filter((p) => p.severity === "warning");

  const out = [...r.intro("pew2 doctor", "checking this machine")];

  const facts = checks(report);
  out.push(...r.step("Checked", plural(facts.length, "thing")));
  for (const check of facts) {
    const mark = check.ok ? s.hex(PALETTE.success, g.tick) : s.hex(PALETTE.warning, g.dot);
    out.push(r.line(`${mark} ${check.label}${check.note ? s.hex(PALETTE.faint, `  ${check.note}`) : ""}`));
  }

  if (errors.length > 0) {
    out.push(...problemRows("Stopping you", plural(errors.length, "problem"), errors, PALETTE.danger, g.cross, options));
  }

  if (warnings.length > 0) {
    // Worded as an offer, not a defect: everything here still works without it.
    out.push(
      ...problemRows("Could be better", "optional", warnings, PALETTE.warning, g.dot, options),
    );
  }

  out.push(...r.outro(summary(report, options)));
  return out;
}
