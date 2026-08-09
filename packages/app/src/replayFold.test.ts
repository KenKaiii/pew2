import { expect, test } from "bun:test";
import {
  foldBackgroundCatchUp,
  foldBackgroundEvent,
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

// The same two, addressed to a second conversation — the one the user is *not*
// reading, which is the whole subject of the background tests below.
const s2User = (seq: number, text: string) => ({ ...user(seq, text), sessionId: "s2" });
const s2Agent = (seq: number, text: string) => ({ ...agent(seq, text), sessionId: "s2" });

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

test("a queued prompt stops saying so once the daemon echoes it back", () => {
  const waiting: Turn = { id: "local:0", key: "local:0", role: "user", text: "Hello", queued: true };
  const next = foldSessionEvents(state([waiting], [sessionStub]), [user(0, "Hello")]);

  expect(next.turns[0]?.queued).toBeUndefined();
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

const permissionEvent = (seq: number, requestId: string, title: string) => ({
  sessionId: "s1",
  seq,
  payload: { kind: "permission_request", requestId, params: { toolCall: { title } } },
});

test("a catch-up puts back the approval the agent is still waiting on", () => {
  // The hang this closes: signal drops between the agent asking and the user
  // tapping. The request *is* in the replayed events, but it is skipped there on
  // purpose (in history it was answered long ago), so the sheet never came back
  // — and nothing times a permission out, so the turn stopped for good. The
  // daemon states the open ones separately, which is the only source that knows.
  const before = {
    ...state([], [sessionStub]),
    activity: IDLE_ACTIVITY,
    loadingSession: false,
  };

  const next = foldCatchUp(before, "s1", [permissionEvent(0, "p1", "Run bash?")], true, 1_000, [
    { requestId: "p1", params: { toolCall: { title: "Run bash?" } } },
  ]);

  expect(next.permission).toMatchObject({ requestId: "p1", title: "Run bash?" });
  // Waiting on this device is not working, whatever the daemon's flag says.
  expect(next.busy).toBe(false);
  // Filed on the conversation too, so leaving the screen does not lose it.
  expect(next.sessions[0]?.permission?.requestId).toBe("p1");
});

test("a catch-up takes down a sheet that was answered elsewhere", () => {
  // The desk answered it while the phone was off the air. An empty list is the
  // daemon saying so, and it has to be acted on: an approve button wired to a
  // resolved request does nothing at all when tapped.
  const before = {
    ...state([], [{ ...sessionStub, permission: { requestId: "p1", title: "Run bash?", options: [] } }]),
    permission: { requestId: "p1", title: "Run bash?", options: [] },
    activity: IDLE_ACTIVITY,
    loadingSession: false,
  };

  const next = foldCatchUp(before, "s1", [], true, 1_000, []);

  expect(next.permission).toBeUndefined();
  expect(next.sessions[0]?.permission).toBeUndefined();
  expect(next.busy).toBe(true);
});

test("a daemon that says nothing about approvals leaves the sheet alone", () => {
  // An older daemon omits the field entirely. Absent is not "none": treating it
  // as none would dismiss a live request the user is looking at.
  const permission = { requestId: "p1", title: "Run bash?", options: [] };
  const before = {
    ...state([], [sessionStub]),
    permission,
    activity: IDLE_ACTIVITY,
    loadingSession: false,
  };

  expect(foldCatchUp(before, "s1", [], true, 1_000).permission).toBe(permission);
});

test("an approval for a conversation off screen is filed, not shown", () => {
  // It belongs to that agent, which is stopped until someone answers. Raising it
  // over the conversation being read would be answering the wrong session; not
  // recording it at all left the other agent stopped with nothing saying why.
  const background = { ...sessionStub, id: "s2" };
  const next = foldBackgroundCatchUp(state([], [sessionStub, background]), "s2", [], true, [
    { requestId: "p9", params: { toolCall: { title: "Delete node_modules?" } } },
  ]);

  expect(next.sessions[1]?.permission).toMatchObject({ requestId: "p9" });
  expect((next as { permission?: unknown }).permission).toBeUndefined();
});

test("a request inside a catch-up batch is not trusted on its own", () => {
  // It may have been answered at the desk during the same blackout. Only the
  // daemon holds the resolvers, so only its list decides — taking it from the
  // replayed event would file an approval the agent was let past minutes ago,
  // and leave a button that posts a dead id.
  const background = { ...sessionStub, id: "s2" };
  const missed = [{ sessionId: "s2", seq: 3, payload: { kind: "permission_request", requestId: "p1" } }];

  expect(
    foldBackgroundCatchUp(state([], [background]), "s2", missed, true, []).sessions[0]?.permission,
  ).toBeUndefined();
  // Still open per the daemon, so it is filed — from the frame, not the event.
  expect(
    foldBackgroundCatchUp(state([], [background]), "s2", missed, true, [{ requestId: "p1" }])
      .sessions[0]?.permission?.requestId,
  ).toBe("p1");
});

test("a live request in a background conversation is filed on its row", () => {
  const background = { ...sessionStub, id: "s2" };
  const next = foldBackgroundEvent(state([], [background]), "s2", "s2:4", {
    kind: "permission_request",
    requestId: "p3",
    params: { toolCall: { title: "Push to main?" } },
  });

  expect(next.sessions[0]?.permission).toMatchObject({ requestId: "p3", title: "Push to main?" });
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
  const next = foldBackgroundCatchUp(state([], [sessionStub, background]), "s2", [], true);

  expect(next.sessions[1]!.busy).toBe(true);
  // Only the one the frame names: nothing is known about the others.
  expect(next.sessions[0]!.busy).toBeUndefined();
});

test("a background catch-up for a finished turn leaves the row quiet", () => {
  const background = { ...sessionStub, id: "s2", busy: true };
  const next = foldBackgroundCatchUp(state([], [background]), "s2", [], false);

  expect(next.sessions[0]!.busy).toBe(false);
});

test("a background catch-up that changes nothing keeps the same array", () => {
  const before = state([], [{ ...sessionStub, id: "s2", busy: true }]);

  expect(foldBackgroundCatchUp(before, "s2", [], true).sessions).toBe(before.sessions);
  expect(foldBackgroundCatchUp(before, "gone", [], true).sessions).toBe(before.sessions);
  expect(foldBackgroundCatchUp(before, undefined, [], true).sessions).toBe(before.sessions);
});

test("missed events land in the conversation they belong to, not the open one", () => {
  const background = { ...sessionStub, id: "s2", busy: true };
  const open = { ...sessionStub, id: "s1", turns: [{ id: "s1:0", role: "user" as const, text: "Mine" }] };
  const before = state(open.turns, [open, background]);
  const next = foldBackgroundCatchUp(before, "s2", [s2Agent(4, "Done, all green.")], true);

  expect(next.sessions[1]!.turns).toEqual([
    { id: "s2:4", role: "agent", text: "Done, all green." },
  ]);
  // The transcript on screen belongs to another conversation and must not
  // move: this is the reply arriving for a session the user is not reading.
  expect(next.turns).toBe(before.turns);
  expect(next.sessions[0]!.turns).toBe(open.turns);
});

test("a reply that lands while the user is elsewhere is there when they return", () => {
  const prompt: Turn = { id: "local:1", role: "user", text: "Fix the bug" };
  const background = { ...sessionStub, id: "s2", turns: [prompt], busy: true };
  const before = state([], [background]);

  // The echo of the prompt, then the answer — the exact sequence that was
  // being dropped, which is why switching away mid-turn used to mean coming
  // back to your own message and silence.
  const withEcho = foldBackgroundEvent(before, "s2", "s2:0", s2User(0, "Fix the bug").payload);
  const next = foldBackgroundEvent(withEcho, "s2", "s2:1", s2Agent(1, "Fixed it.").payload);

  expect(next.sessions[0]!.turns).toEqual([
    // Adopted in place rather than duplicated, same as the visible path.
    { id: "s2:0", role: "user", text: "Fix the bug" },
    { id: "s2:1", role: "agent", text: "Fixed it." },
  ]);
  expect(next.sessions[0]!.title).toBe("Fix the bug");
});

test("a background session's chunks coalesce into one bubble like any other", () => {
  const background = { ...sessionStub, id: "s2" };
  let next = state([], [background]);
  for (const [seq, text] of [[0, "Looking "], [1, "into "], [2, "it"]] as const) {
    next = foldBackgroundEvent(next, "s2", `s2:${seq}`, s2Agent(seq, text).payload);
  }

  expect(next.sessions[0]!.turns).toEqual([{ id: "s2:0", role: "agent", text: "Looking into it" }]);
  // Streaming prose marks the row as working, so the drawer dot and the
  // spinner say the same thing about the same session.
  expect(next.sessions[0]!.busy).toBe(true);
});

test("an event for a conversation the drawer does not hold changes nothing", () => {
  const before = state([], [sessionStub]);

  expect(foldBackgroundEvent(before, "gone", "gone:0", s2Agent(0, "Hi").payload)).toBe(before);
  expect(foldBackgroundEvent(before, undefined, "x:0", s2Agent(0, "Hi").payload)).toBe(before);
  // A tool call is not a chunk: nothing to render into a transcript that is
  // not on screen, and no reason to re-render the drawer for it.
  expect(foldBackgroundEvent(before, "s1", "s1:0", { update: { sessionUpdate: "tool_call" } })).toBe(
    before,
  );
});