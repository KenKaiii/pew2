/** Orb motion follows reported ACP work, never an invented progress stage. */
import type { OrbState } from "thinking-orbs/engine";
import { currentTool, queuedTools, type Activity, type ToolKind } from "./activity";

const TOOL_STATES: Record<ToolKind, OrbState> = {
  read: "listening",
  edit: "composing",
  delete: "shaping",
  move: "shaping",
  search: "searching",
  execute: "working",
  think: "solving",
  fetch: "connecting",
  other: "working",
};

export function activityOrbState(activity: Activity): OrbState {
  if (queuedTools(activity) > 0) return "weaving";
  const tool = currentTool(activity);
  if (tool) return TOOL_STATES[tool.kind];
  return activity.speaking ? "composing" : "breathing";
}
