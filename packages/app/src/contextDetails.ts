import { usageAccessibilityLabel, usageLabel, usageLevel, usagePercent, type ContextUsage } from "./contextUsage";
import { changesAccessibilityLabel, changesLabel } from "./workspaceLabel";
import type { Workspace } from "./useDaemon";

/** Shared resting-row/detail policy. Unknown readings are never zero or clean. */
export function contextDetails(workspace?: Workspace, usage?: ContextUsage) {
  const knownUsage = usage && Number.isFinite(usage.used) && usage.used >= 0 && Number.isFinite(usage.size) && usage.size > 0 ? usage : undefined;
  const knownChanges = workspace?.repo === true && typeof workspace.uncommitted === "number" && Number.isFinite(workspace.uncommitted) && workspace.uncommitted >= 0 ? workspace.uncommitted : undefined;
  const level = knownUsage ? usageLevel(usagePercent(knownUsage)) : undefined;
  return {
    project: workspace?.folder || "Unknown project",
    usage: knownUsage ? usageLabel(knownUsage) : "Context usage unavailable",
    usageAccessibility: knownUsage ? usageAccessibilityLabel(knownUsage) : "Context usage unavailable",
    level,
    warning: level === "high" || level === "critical",
    dirty: knownChanges !== undefined && knownChanges > 0,
    changes: knownChanges !== undefined ? changesLabel(knownChanges) : workspace?.repo === false ? "Not a Git repository" : "Change count unavailable",
    changesAccessibility: knownChanges !== undefined ? changesAccessibilityLabel(knownChanges) : workspace?.repo === false ? "Not a Git repository" : "Change count unavailable",
  };
}
