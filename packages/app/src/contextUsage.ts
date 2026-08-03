/**
 * How full the agent's context window is.
 *
 * ACP's `usage_update` carries `used` and `size` in tokens. That is the one
 * number that predicts the thing users actually feel: when it approaches the
 * window, the agent compacts — it summarises the conversation and drops the
 * detail — and answers quietly stop referring to things said earlier. Before
 * this, that arrived with no warning at all, and the summary markers were
 * filtered out of the transcript, so the agent simply appeared to forget.
 *
 * Shown as a percentage and nothing else. Tokens are a unit nobody has an
 * intuition for ("21,325 of 1,000,000" needs arithmetic to be a feeling),
 * while "2%" and "88%" are immediate. The precise counts stay in the
 * accessibility label, where there is room to be exact.
 *
 * Pure and Expo-free, so `bun test` can load it.
 */

/** The tokens an agent reported. Absent for agents that never send it. */
export interface ContextUsage {
  /** Tokens currently in context. */
  used: number;
  /** The window's total size in tokens. */
  size: number;
}

/**
 * Pull a usage reading out of a `session/update` payload.
 *
 * Mirrors `readAvailableCommands`: the same shape of guard, in the same place
 * in the fold, because both describe the session rather than a turn. Numbers
 * are validated rather than trusted — this crosses a wire from a process this
 * app does not control, and a string `size` would render "NaN%".
 */
export function readUsage(payload: any): ContextUsage | undefined {
  const update = payload?.update;
  if (update?.sessionUpdate !== "usage_update") return undefined;
  const { used, size } = update;
  if (typeof used !== "number" || typeof size !== "number") return undefined;
  if (!Number.isFinite(used) || !Number.isFinite(size)) return undefined;
  return { used, size };
}

/** Severity bands, in the order the row escalates through them. */
export type UsageLevel = "normal" | "high" | "critical";

/**
 * Percent full, rounded to a whole number and clamped to 0–100.
 *
 * Rounded *up* below 1%, because a fresh session already holding a system
 * prompt is not "0%" — a meter reading zero while tokens are plainly being
 * spent reads as broken. Everything else rounds normally.
 */
export function usagePercent(usage: ContextUsage): number {
  if (!(usage.size > 0)) return 0;
  const ratio = usage.used / usage.size;
  if (ratio <= 0) return 0;
  if (ratio >= 1) return 100;
  const percent = ratio * 100;
  return percent < 1 ? 1 : Math.round(percent);
}

/**
 * Where a percentage sits on the escalation.
 *
 * 75 and 90 rather than a smooth gradient: a colour that drifts continuously is
 * not readable as a state, and the only two moments that matter are "start
 * thinking about wrapping this up" and "compaction is imminent".
 */
export function usageLevel(percent: number): UsageLevel {
  if (percent >= 90) return "critical";
  if (percent >= 75) return "high";
  return "normal";
}

/** The row's own text. Percent only — the row is one line and already busy. */
export function usageLabel(usage: ContextUsage): string {
  return `${usagePercent(usage)}%`;
}

/**
 * Spoken form. Says what the number *means*, since "88%" alone is ambiguous
 * when read aloud beside a file count, and names the risk at the top band.
 */
export function usageAccessibilityLabel(usage: ContextUsage): string {
  const percent = usagePercent(usage);
  const detail = `${percent}% of context used, ${usage.used.toLocaleString()} of ${usage.size.toLocaleString()} tokens`;
  return usageLevel(percent) === "critical" ? `${detail}. Compaction is close.` : detail;
}

