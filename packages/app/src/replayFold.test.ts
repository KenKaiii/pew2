import { expect, test } from "bun:test";
import {
  foldBackgroundCatchUp,
  foldCatchUp,
  foldSessionEvents,
  isOptimistic,
} from "./replayFold";
import { currentTool, IDLE_ACTIVITY } from "./activity";
import type { PermissionRequest, Session, Turn } from "./useDaemon";

const user = (seq: number, text: string) => ({
  sessionId: "s1",
  seq,
  payload: { update: { sessionUpdate: "user_message_chunk", content: { text } } },
});
const agent = (seq: number, text: string) => ({
  sessionId: "s1",
  seq,
  payload: { update: { sessionUpdate: "agent_message_chunk", content: { text } } },
});

const state = (turns: Turn[] = [], sessions: Session[] = []) => ({
  turns,
  sessions,
  busy: true,
  permission: undefined as PermissionRequest | undefined,
});

const sessionStub: Session = {
  id: "s1",
  providerId: "ggcoder",
  title: "New conversation",
  startedAt: 1,
  turns: [],
  configOptions: [],
};

test("a batch of chunks lands as coalesced turns in one state", () => {
  const next = foldSessionEvents(
    state([], [sessionStub]),
    [user(0, "Fix the bug"), agent(1, "Looking "), agent(2, "into it"), agent(3, " now")],
  );

  expect(next.turns).toEqual([
    { id: "s1:0", role: "user", text: "Fix the bug" },
    { id: "s1:1", role: "agent", text: "Looking into it now" },
  ]);
  expect(next.busy).toBe(true);
});

test("replayed messages sent either side of a tool call keep their paragraph break", () => {
  // Tool calls create no turn, so messages the agent sent while working all
  // coalesce into one bubble. Concatenated bare, a resumed thread rendered
  // "Let me check.Ah, I found it." — and replay must reproduce exactly what the
  // live path showed, or history looks unlike the conversation that made it.
  const next = foldSessionEvents(state([], [sessionStub]), [
    agent(0, "Let me check."),
    agent(1, "Ah, I found it."),
  ]);

  expect(next.turns[0]?.text).toBe("Let me check.\n\nAh, I found it.");
});

test("the session mirror gains the turns and a title from the first user message", () => {
  const next = foldSessionEvents(state([], [sessionStub]), [user(0, "Refactor auth"), agent(1, "On it")]);

  expect(next.sessions[0]?.title).toBe("Refactor auth");
  expect(next.sessions[0]?.turns).toHaveLength(2);
});

test("an optimistic prompt is adopted, not duplicated", () => {
  const optimisticTurn: Turn = { id: "local:0", role: "user", text: "Hello" };
  const next = foldSessionEvents(state([optimisticTurn], [sessionStub]), [user(0, "Hello")]);

  expect(next.turns).toHaveLength(1);
  expect(next.turns[0]?.id).toBe("s1:0");
  expect(isOptimistic(next.turns[0]!)).toBe(false);
});

test("adoption keeps the render key, so the prompt does not remount", () => {
  const optimisticTurn: Turn = {
    id: "local:0",
    key: "local:0",
    role: "user",
    text: "Hello",
  };
  const next = foldSessionEvents(state([optimisticTurn], [sessionStub]), [
    user(0, "Hello"),
  ]);

  expect(next.turns[0]?.key).toBe("local:0");
});

test("a replay is history: it never marks the session busy", () => {
  // The looping-indicator bug: the fold used to set busy from the last chunk,
  // and a resumed thread's last chunk is always a message.
  const next = foldSessionEvents(state([], [sessionStub]), [user(0, "Hi"), agent(1, "Done")]);

  expect(next.busy).toBe(true); // unchanged from the state passed in
  const idle = foldSessionEvents({ ...state([], []), busy: false }, [agent(0, "Done")]);
  expect(idle.busy).toBe(false);
});

test("a permission request in replayed history does not resurface", () => {
  // It was answered when the conversation was live; asking again would be a
  // phantom banner over a finished thread.
  const next = foldSessionEvents(state([], []), [
    {
      sessionId: "s1",
      seq: 0,
      payload: { kind: "permission_request", requestId: "p1", params: { toolCall: { title: "Run bash?" } } },
    },
  ]);

  expect(next.permission).toBeUndefined();
});

test("an empty batch returns the same state", () => {
  const prev = state([], []);
  expect(foldSessionEvents(prev, [])).toBe(prev);
});

test("other sessions in the list are untouched", () => {
  const other: Session = { ...sessionStub, id: "s2", title: "Kept" };
  const next = foldSessionEvents(state([], [sessionStub, other]), [user(0, "Hi")]);

  expect(next.sessions[1]).toBe(other);
});

test("a replayed picture folds into the bubble it belongs to", () => {
  const next = foldSessionEvents(state([], [sessionStub]), [
    agent(0, "Rendered it:"),
    {
      sessionId: "s1",
      seq: 1,
      payload: {
        update: {
          sessionUpdate: "tool_call_update",
          content: [{ type: "content", content: { type: "resource_link", uri: "out/plot.png" } }],
        },
      },
    },
  ]);

  // One turn, not two: the picture is part of what the agent just said.
  expect(next.turns).toEqual([
    {
      id: "s1:0",
      role: "agent",
      text: "Rendered it:",
      images: [{ src: "out/plot.png", mimeType: undefined, alt: undefined }],
    },
  ]);
});

test("a picture without words still becomes a turn", () => {
  // Text-only emptiness checks dropped these, which is what left the thread
  // blank after an image generation tool ran.
  const next = foldSessionEvents(state([], [sessionStub]), [
    {
      sessionId: "s1",
      seq: 0,
      payload: {
        update: {
          sessionUpdate: "agent_message_chunk",
          content: [{ type: "image", mimeType: "image/png", data: "AA" }],
        },
      },
    },
  ]);

  expect(next.turns).toHaveLength(1);
  expect(next.turns[0]!.images).toHaveLength(1);
});

test("replay restores the context percentage, unlike busy", () => {
  // The last reading is the session's current state, not a description of work
  // in progress: without this a reconnect blanks the meter until the agent
  // happens to send another one, mid-conversation, when it matters most.
  const state = {
    turns: [],
    sessions: [],
    busy: false,
    usage: undefined as { used: number; size: number } | undefined,
  };

  const folded = foldSessionEvents(state, [
    { sessionId: "s1", seq: 1, payload: { update: { sessionUpdate: "usage_update", used: 10, size: 1000 } } },
    { sessionId: "s1", seq: 2, payload: { update: { sessionUpdate: "usage_update", used: 250, size: 1000 } } },
  ]);

  expect(folded.usage).toEqual({ used: 250, size: 1000 });
  // Still history, so it must not look like a turn in progress.
  expect(folded.busy).toBe(false);
});

const toolCall = (seq: number, id: string, title: string) => ({
  sessionId: "s1",
  seq,
  payload: {
    update: { sessionUpdate: "tool_call", toolCallId: id, title, kind: "execute", status: "in_progress" },
  },
});

test("a catch-up names the tool the agent is running right now", () => {
  // The whole point of the frame. A phone that lost its socket mid-turn — screen
  // lock, wifi to cellular, a relay blip — used to come back and show nothing at
  // all until the agent happened to start its *next* tool. That read as twenty
  // seconds of a dead screen followed by a shell command out of nowhere.
  const before = {
    ...state([], [sessionStub]),
    activity: IDLE_ACTIVITY,
    loadingSession: false,
  };

  const next = foldCatchUp(
    before,
    "s1",
    [agent(0, "Checking the logs"), toolCall(1, "t1", "rg needle src")],
    true,
    1_000,
  );

  expect(currentTool(next.activity)?.title).toBe("rg needle src");
  expect(next.busy).toBe(true);
  expect(next.turns[0]?.text).toBe("Checking the logs");
  expect(next.sessions[0]?.busy).toBe(true);
});

test("a catch-up on a turn that already ended settles, rather than spinning", () => {
  // `session.idle` is broadcast and never logged, so a turn that finished while
  // this client was away replays no event that says so. Only the daemon's flag
  // can end it — inferring "still working" from the last event would leave the
  // conversation pulsing in the drawer for as long as the app stayed open.
  const before = {
    ...state([], [{ ...sessionStub, busy: true }]),
    activity: IDLE_ACTIVITY,
    loadingSession: false,
  };

  const next = foldCatchUp(before, "s1", [toolCall(0, "t1", "rg needle src")], false, 1_000);

  expect(next.busy).toBe(false);
  expect(next.activity).toBe(IDLE_ACTIVITY);
  expect(next.sessions[0]?.busy).toBe(false);
});

test("a catch-up dismisses the loading skeleton it arrived behind", () => {
  const before = {
    ...state([], [sessionStub]),
    activity: IDLE_ACTIVITY,
    loadingSession: true,
  };

  expect(foldCatchUp(before, "s1", [], true, 1_000).loadingSession).toBe(false);
});

test("a background conversation still working survives the reconnect busy sweep", () => {
  const background = { ...sessionStub, id: "s2", busy: false };
  const next = foldBackgroundCatchUp(state([], [sessionStub, background]), "s2", true);

  expect(next.sessions[1]!.busy).toBe(true);
  // Only the one the frame names: nothing is known about the others.
  expect(next.sessions[0]!.busy).toBeUndefined();
});

test("a background catch-up for a finished turn leaves the row quiet", () => {
  const background = { ...sessionStub, id: "s2", busy: true };
  const next = foldBackgroundCatchUp(state([], [background]), "s2", false);

  expect(next.sessions[0]!.busy).toBe(false);
});

test("a background catch-up that changes nothing keeps the same array", () => {
  const before = state([], [{ ...sessionStub, id: "s2", busy: true }]);

  expect(foldBackgroundCatchUp(before, "s2", true).sessions).toBe(before.sessions);
  expect(foldBackgroundCatchUp(before, "gone", true).sessions).toBe(before.sessions);
  expect(foldBackgroundCatchUp(before, undefined, true).sessions).toBe(before.sessions);
});
