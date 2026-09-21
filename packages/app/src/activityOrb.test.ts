import { expect, test } from "bun:test";
import { activityOrbState } from "./activityOrb";
import { type Activity, type ToolKind } from "./activity";
import { MODE_FRAMES, resolvePreset, type OrbState } from "thinking-orbs/engine";

const activity = (kind: ToolKind): Activity => ({ startedAt: 1, speaking: false, tools: [{id:"tool",title:"Agent's actual tool title",kind,status:"in_progress"}] });

test.each([
  ["read", "listening"], ["edit", "composing"], ["delete", "shaping"],
  ["move", "shaping"], ["search", "searching"], ["execute", "working"],
  ["think", "solving"], ["fetch", "connecting"], ["other", "working"],
] as const)("%s uses the %s orb without rewriting the tool title", (kind, state) => {
  const input = activity(kind);
  expect(activityOrbState(input)).toBe(state);
  expect(input.tools[0]!.title).toBe("Agent's actual tool title");
});

test("parallel tools weave; awaiting the agent breathes; text composition composes", () => {
  const input = activity("search");
  input.tools.push({id:"second",title:"Read config",kind:"read",status:"pending"});
  expect(activityOrbState(input)).toBe("weaving");
  expect(activityOrbState({tools:[],speaking:false})).toBe("breathing");
  expect(activityOrbState({tools:[],speaking:true})).toBe("composing");
});

test.each<OrbState>(["working","searching","solving","listening","connecting","weaving","composing","breathing","shaping"])("pinned upstream %s engine produces finite 20px native draw instructions", (state) => {
  const preset = resolvePreset(state, 20);
  for (const t of [0, 0.6, 1.2]) {
    const frame = MODE_FRAMES[preset.mode](20, t * preset.speed, preset.opts);
    expect(frame.dots.length).toBeGreaterThan(0);
    expect(frame.dots.length).toBeLessThan(1000);
    for (const dot of frame.dots) {
      for (const value of [dot.x,dot.y,dot.r,dot.white,dot.a ?? 1]) expect(Number.isFinite(value)).toBe(true);
      expect(dot.r).toBeGreaterThan(0);
    }
    for (const line of frame.lines) for (const value of [line.x1,line.y1,line.x2,line.y2,line.w]) expect(Number.isFinite(value)).toBe(true);
  }
});
