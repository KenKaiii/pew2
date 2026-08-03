import { describe, expect, test } from "bun:test";
import {
  beginActivity,
  currentTool,
  foldActivity,
  formatDuration,
  formatTokens,
  queuedTools,
  receiptText,
  summariseActivity,
  IDLE_ACTIVITY,
  type Activity,
} from "./activity";

const call = (id: string, extra: Record<string, unknown> = {}) => ({
  update: { sessionUpdate: "tool_call", toolCallId: id, title: `Tool ${id}`, ...extra },
});

const update = (id: string, extra: Record<string, unknown>) => ({
  update: { sessionUpdate: "tool_call_update", toolCallId: id, ...extra },
});

const says = (text: string, sessionUpdate = "agent_message_chunk") => ({
  update: { sessionUpdate, content: { type: "text", text } },
});

function fold(events: any[], start = 1000): Activity {
  return events.reduce<Activity>(
    (state, event) => foldActivity(state, event, start),
    beginActivity(start),
  );
}

describe("foldActivity", () => {
  test("records a tool call with its title and kind", () => {
    const state = fold([call("a", { kind: "execute", status: "in_progress" })]);
    expect(state.tools).toEqual([
      { id: "a", title: "Tool a", kind: "execute", status: "in_progress" },
    ]);
  });

  test("an unknown kind or status falls back rather than being trusted", () => {
    const state = fold([call("a", { kind: "sorcery", status: "vibing" })]);
    expect(state.tools[0]).toMatchObject({ kind: "other", status: "pending" });
  });

  test("an update revises in place and leaves absent fields alone", () => {
    const state = fold([
      call("a", { kind: "read", status: "pending" }),
      update("a", { status: "completed" }),
    ]);
    expect(state.tools).toHaveLength(1);
    expect(state.tools[0]).toMatchObject({ title: "Tool a", kind: "read", status: "completed" });
  });

  test("returns the same object when nothing changed", () => {
    const state = fold([call("a", { status: "in_progress" })]);
    expect(foldActivity(state, update("a", { status: "in_progress" }), 2000)).toBe(state);
    expect(foldActivity(state, { update: { sessionUpdate: "agent_message_chunk" } }, 2000)).toBe(
      state,
    );
  });

  test("an update for a tool never seen still counts as work", () => {
    const state = fold([update("ghost", { status: "in_progress" })]);
    expect(state.tools).toHaveLength(1);
  });

  test("starts the clock even when the first event is a tool call", () => {
    const state = foldActivity(IDLE_ACTIVITY, call("a"), 500);
    expect(state.startedAt).toBe(500);
  });

  test("picks up a token figure the agent volunteered", () => {
    const state = foldActivity(IDLE_ACTIVITY, { _meta: { usage: { input: 900, output: 600 } } }, 0);
    expect(state.tokens).toBe(1500);
  });
});

describe("currentTool", () => {
  test("names the newest running tool", () => {
    const state = fold([
      call("a", { status: "in_progress" }),
      call("b", { status: "in_progress" }),
    ]);
    expect(currentTool(state)?.id).toBe("b");
    expect(queuedTools(state)).toBe(1);
  });

  test("holds the last finished tool rather than blinking out between calls", () => {
    const state = fold([call("a", { status: "completed" })]);
    expect(currentTool(state)?.id).toBe("a");
    expect(queuedTools(state)).toBe(0);
  });

  test("is undefined before any tool runs", () => {
    expect(currentTool(IDLE_ACTIVITY)).toBeUndefined();
  });

  test("steps aside while the agent is answering, and returns on the next tool", () => {
    let state = fold([call("a", { status: "completed" })]);
    expect(currentTool(state)?.id).toBe("a");

    state = foldActivity(state, says("Here is what I found"), 0);
    expect(currentTool(state)).toBeUndefined();

    state = foldActivity(state, call("b", { status: "in_progress" }), 0);
    expect(currentTool(state)?.id).toBe("b");
  });

  test("thinking is not answering: the tool stays named", () => {
    let state = fold([call("a", { status: "in_progress" })]);
    state = foldActivity(state, says("Considering...", "agent_thought_chunk"), 0);
    expect(currentTool(state)?.id).toBe("a");
  });

  test("a tool merely reporting that it finished does not interrupt the answer", () => {
    let state = fold([call("a", { status: "in_progress" })]);
    state = foldActivity(state, says("Done, here is why"), 0);
    state = foldActivity(state, update("a", { status: "completed" }), 0);
    expect(currentTool(state)).toBeUndefined();
  });

  test("a replayed summary marker is not the agent speaking", () => {
    let state = fold([call("a", { status: "in_progress" })]);
    state = foldActivity(state, says("[Previous conversation summary] ..."), 0);
    expect(currentTool(state)?.id).toBe("a");
  });
});

describe("summariseActivity", () => {
  test("names what the turn did, most consequential family first", () => {
    const state = fold([
      call("a", { kind: "read" }),
      call("b", { kind: "execute" }),
      call("c", { kind: "edit" }),
    ]);
    const receipt = summariseActivity(state, 1000 + 113_000)!;
    expect(receipt.verb).toBe("Edited & ran");
    expect(receipt.duration).toBe("1m 53s");
    expect(receipt.tools).toBe(3);
  });

  test("a turn with no tools is an answer", () => {
    const receipt = summariseActivity(beginActivity(0), 8_000)!;
    expect(receipt.verb).toBe("Answered");
    expect(receiptText(receipt)).toBe("Answered in 8s");
  });

  test("a failed tool is counted, not folded into the verb", () => {
    const state = fold([
      call("a", { kind: "execute", status: "failed" }),
      call("b", { kind: "execute", status: "completed" }),
    ]);
    const receipt = summariseActivity(state, 1000 + 5000)!;
    expect(receipt.verb).toBe("Ran");
    expect(receiptText(receipt)).toBe("Ran in 5s · 2 tools · 1 failed");
  });

  test("tokens appear only when the agent reported them", () => {
    const state = { ...beginActivity(0), tokens: 1523 };
    expect(receiptText(summariseActivity(state, 4000)!)).toBe("Answered in 4s · ↓ 1.5k tokens");
  });

  test("nothing to report for an untimed or instant turn", () => {
    expect(summariseActivity(IDLE_ACTIVITY, 5000)).toBeUndefined();
    expect(summariseActivity(beginActivity(0), 400)).toBeUndefined();
  });
});

describe("formatting", () => {
  test("durations read as a person would say them", () => {
    expect(formatDuration(900)).toBe("1s");
    expect(formatDuration(59_400)).toBe("59s");
    expect(formatDuration(120_000)).toBe("2m");
    expect(formatDuration(113_000)).toBe("1m 53s");
    expect(formatDuration(3_600_000)).toBe("1h");
    expect(formatDuration(3_900_000)).toBe("1h 5m");
  });

  test("token counts stay one glance wide", () => {
    expect(formatTokens(820)).toBe("820");
    expect(formatTokens(1523)).toBe("1.5k");
    expect(formatTokens(2000)).toBe("2k");
    expect(formatTokens(12_400)).toBe("12k");
    expect(formatTokens(1_240_000)).toBe("1.2M");
  });
});
