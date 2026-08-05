/**
 * What `pew2 registry sync` shows you.
 *
 * The registry holds around thirty agents, and the old screen gave each one its
 * own green tick — thirty lines that all said the same thing, with the two lines
 * that actually needed a decision buried underneath.
 *
 * Bulk outcomes belong in a count and a wrapped list of names. The exceptions —
 * a manifest pew2 will not overwrite — are what deserve rows, because they are
 * the only part the user can act on.
 */
import { PALETTE, styler, glyphs } from "./ui.js";
import { rail, plural, wrapDetail, detailWidth, type RenderOptions } from "./rail.js";
import type { SyncResult } from "./registry-sync.js";

export interface RegistryViewOptions extends RenderOptions {
  dryRun?: boolean;
}

/**
 * Names, wrapped, rather than one line each.
 *
 * Thirty ids down the left edge is a wall; the same thirty as prose is a
 * sentence you can skim and stop reading when you have seen enough.
 */
function nameList(ids: string[], options: RenderOptions): string[] {
  return wrapDetail(ids.join(", "), detailWidth(options) - 2);
}

export function registryView(result: SyncResult, options: RegistryViewOptions = {}): string[] {
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  const r = rail(options);
  const dryRun = options.dryRun ?? false;

  const out = [
    ...r.intro("pew2 registry", `the public ACP registry, v${result.registryVersion}`),
  ];

  if (result.written.length > 0) {
    // The destination is named because it moves: it follows PEW2_HOME, and
    // "3 agents added" with no path leaves nowhere to go and look.
    out.push(
      ...r.step(
        dryRun ? "Would add" : "Added",
        `${plural(result.written.length, "agent")} in ${result.targetDir}`,
      ),
    );
    for (const part of nameList(result.written, options)) {
      out.push(r.line(s.hex(PALETTE.faint, part)));
    }
  }

  if (result.conflicts.length > 0) {
    // The only section that asks anything of the reader, so it is the only one
    // that gets a mark per row.
    out.push(...r.step("Left alone", "already has a manifest here"));
    for (const id of result.conflicts) {
      out.push(r.line(`${s.hex(PALETTE.warning, g.dot)} ${s.bold(id)}`));
    }
    out.push(r.line(s.hex(PALETTE.faint, `Run with --force to replace ${result.conflicts.length === 1 ? "it" : "them"}.`)));
  }

  // Everything below is context, not action: things already handled, or agents
  // that cannot run on this platform at all.
  const unavailable = result.skipped.filter((k) => k.kind === "unsupported");
  const bundled = result.skipped.length - unavailable.length;
  const notes: string[] = [];
  if (result.unchanged.length > 0) notes.push(`${result.unchanged.length} already up to date`);
  if (bundled > 0) notes.push(`${bundled} already ship with pew2`);
  if (unavailable.length > 0) notes.push(`${unavailable.length} not available on this platform`);

  if (notes.length > 0) {
    out.push(...r.step("Skipped", plural(result.unchanged.length + result.skipped.length, "agent")));
    for (const note of notes) out.push(r.line(s.hex(PALETTE.faint, note)));
  }

  if (result.written.length === 0 && result.conflicts.length === 0) {
    out.push(...r.outro(`${s.hex(PALETTE.success, g.tick)} ${s.bold("Nothing to do.")} ${s.hex(PALETTE.faint, "You already have every agent in the registry.")}`));
    return out;
  }

  const verb = dryRun ? "would be added" : "added";
  out.push(
    ...r.outro(
      dryRun
        ? `${s.bold(`${plural(result.written.length, "agent")} ${verb}.`)} ${s.hex(PALETTE.faint, "Run without --dry-run to do it.")}`
        : `${s.hex(PALETTE.success, g.tick)} ${s.bold(`${plural(result.written.length, "agent")} added.`)} ${s.hex(PALETTE.faint, "Run")} ${s.bold("pew2 providers list")} ${s.hex(PALETTE.faint, "to see them.")}`,
    ),
  );
  return out;
}
