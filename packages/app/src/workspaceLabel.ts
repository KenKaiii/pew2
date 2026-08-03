/**
 * Wording for the git chip above the composer.
 *
 * Pure and React-Native-free so it stays testable: `bun test` cannot parse
 * React Native's Flow syntax, so anything importing a component is untestable
 * here. The phrasing is the whole feature — "2 uncommitted" has to read as a
 * fact about the project, and a clean tree must say so rather than "0".
 */
export function changesLabel(uncommitted: number): string {
  if (uncommitted <= 0) return "clean";
  return `${uncommitted} uncommitted`;
}

/** Spoken form, for screen readers, where "2 uncommitted" is ambiguous. */
export function changesAccessibilityLabel(uncommitted: number): string {
  if (uncommitted <= 0) return "Working directory clean";
  if (uncommitted === 1) return "1 uncommitted file";
  return `${uncommitted} uncommitted files`;
}
