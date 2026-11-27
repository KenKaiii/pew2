/**
 * Queued messages, ask_user and GG Coder goals (CONTRACT.md, Layer 2).
 *
 * The queue's turn mechanics are tested against a planted session whose agent
 * answers on demand; everything that crosses ACP (`_gg/*`) runs against
 * `testing/gg-agent.ts`, a real ACP peer that advertises `_meta.gg`.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Daemon } from "./index.js";
import { handleMessage } from "./handler.js";
import { SessionLog } from "./session/log.js";
import type { AcpSessionHandle } from "./acp/connect.js";
import type { LoadedProvider } from "./providers/registry.js";
import { fileURLToPath } from "node:url";
import { taskFilePath } from "./gg-tasks.js";

async function until<T>(read: () => T | undefined, what: string, ms = 8000): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined && value !== false) return value;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${what}`);
}

function daemonWithCollector() {
  const sent: any[] = [];
  const daemon = new Daemon({ id: "test", name: "test" });
  daemon.attach((message) => sent.push(message));
  return { daemon, sent };
}

/** An agent whose turns end only when the test says so. */
function plantControlledSession(daemon: Daemon, sessionId: string) {
  const turns: { text: string; attachments: any[]; finish: (error?: Error) => void }[] = [];
  const cancels: number[] = [];
  const handle = {
    sessionId: "agent-1",
    prompt: (text: string, attachments: any[] = []) =>
      new Promise<void>((resolve, reject) => {
        turns.push({ text, attachments, finish: (error) => (error ? reject(error) : resolve()) });
      }),
    cancel: async () => {
      cancels.push(Date.now());
    },
    close: () => {},
  } as unknown as AcpSessionHandle;
  const session = {
    handle,
    log: new SessionLog(sessionId),
    providerId: "test",
    cwd: tmpdir(),
    live: false,
    lastUsedAt: Date.now(),
    ready: Promise.resolve(),
    agentSessionId: "agent-1",
  };
  (daemon as any).sessions.set(sessionId, session);
  daemon.markLive(sessionId);
  return { session, turns, cancels };
}

const userMessages = (sent: any[]) =>
  sent
    .filter((m) => m.t === "session.event" && m.payload?.kind === "user_message")
    .map((m) => m.payload);
const lastQueue = (sent: any[]) => sent.findLast((m) => m.t === "session.queue");

test("a prompt mid-turn is queued, then everything queued goes as ONE next turn", async () => {
  const { daemon, sent } = daemonWithCollector();
  const { turns } = plantControlledSession(daemon, "s1");

  const first = daemon.prompt("s1", "first");
  await until(() => turns.length === 1, "first turn");
  expect(await daemon.prompt("s1", "second")).toBe("queued");
  expect(
    await daemon.prompt("s1", "third", [
      { name: "a.png", mimeType: "image/png", data: Buffer.from("PNG").toString("base64") },
    ]),
  ).toBe("queued");

  expect(lastQueue(sent).queued).toEqual([
    { id: "q_1", text: "second" },
    { id: "q_2", text: "third", attachments: 1 },
  ]);
  // Not yet a user turn: it has not reached the agent.
  expect(userMessages(sent).map((m) => m.text)).toEqual(["first"]);
  // The catch-up carries it as live state.
  expect(daemon.catchUp({ s1: 0 })[0]?.queued).toHaveLength(2);

  turns[0]!.finish();
  await until(() => turns.length === 2, "follow-up turn");
  expect(turns[1]!.text).toBe("second\n\nthird");
  expect(turns[1]!.attachments).toHaveLength(1);
  expect(await Bun.file(turns[1]!.attachments[0].path).text()).toBe("PNG");
  // Each logged as its own user message, when it actually went out.
  const logged = userMessages(sent);
  expect(logged.map((m) => m.text)).toEqual(["first", "second", "third"]);
  expect(logged[2].attachments[0].uri).toBe(turns[1]!.attachments[0].path);
  expect(lastQueue(sent).queued).toEqual([]);

  // The original prompt settles only once the session is idle again.
  let settled = false;
  void first.then(() => (settled = true));
  await Bun.sleep(5);
  expect(settled).toBe(false);
  turns[1]!.finish();
  expect(await first).toBe("ran");
  expect(daemon.catchUp({ s1: 0 })[0]).toMatchObject({ working: false, queued: [] });
});

test("cancelling a turn hands the queue back instead of running it", async () => {
  const { daemon, sent } = daemonWithCollector();
  const { turns, cancels } = plantControlledSession(daemon, "s1");
  const first = daemon.prompt("s1", "first");
  await until(() => turns.length === 1, "first turn");
  await daemon.prompt("s1", "later");

  await daemon.cancel("s1");
  expect(cancels).toHaveLength(1);
  expect(lastQueue(sent)).toMatchObject({ queued: [], returned: [{ text: "later" }] });

  turns[0]!.finish();
  await first;
  expect(turns).toHaveLength(1);
  expect(userMessages(sent).map((m) => m.text)).toEqual(["first"]);
});

test("one queued message can be withdrawn; a failed turn returns the rest", async () => {
  const { daemon, sent } = daemonWithCollector();
  const { turns } = plantControlledSession(daemon, "s1");
  const first = daemon.prompt("s1", "first");
  await until(() => turns.length === 1, "first turn");
  await daemon.prompt("s1", "a");
  await daemon.prompt("s1", "b");

  expect(await daemon.cancelQueued("s1", "q_1")).toBe(true);
  expect(lastQueue(sent).queued).toEqual([{ id: "q_2", text: "b" }]);
  expect(await daemon.cancelQueued("s1", "q_1")).toBe(false);

  turns[0]!.finish(new Error("agent fell over"));
  await expect(first).rejects.toThrow("agent fell over");
  expect(lastQueue(sent)).toMatchObject({ queued: [], returned: [{ id: "q_2" }] });
  expect(turns).toHaveLength(1);
});

// ── Against the fake GG agent ───────────────────────────────

const ggProvider: LoadedProvider = {
  manifest: {
    id: "ggcoder",
    name: "GG Coder",
    description: "",
    pew: { transport: "acp", requiresWorkspace: false, commandDirs: [] },
  } as unknown as LoadedProvider["manifest"],
  source: "<test>",
  command: "bun",
  args: ["run", fileURLToPath(new URL("./testing/gg-agent.ts", import.meta.url))],
  missingEnv: [],
  commandMissing: false,
};

const restoreEnv: (() => void)[] = [];
let openDaemons: Daemon[] = [];
afterEach(() => {
  for (const daemon of openDaemons) daemon.closeAll();
  openDaemons = [];
  for (const restore of restoreEnv.splice(0)) restore();
});

function setEnv(key: string, value: string | undefined) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  restoreEnv.push(() => {
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  });
}

async function ggDaemon({ old = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pew2-gg-"));
  setEnv("PEW2_HOME", join(root, "home"));
  setEnv("PEW2_WORKSPACE", root);
  setEnv("PEW2_TEST_GOALS_ROOT", join(root, "goals"));
  setEnv("PEW2_TEST_GG_OLD", old ? "1" : undefined);
  const { daemon, sent } = daemonWithCollector();
  (daemon as any).providers = [ggProvider];
  openDaemons.push(daemon);
  const ctx = {
    daemon,
    reply: (message: unknown) => sent.push({ ...(message as object), replied: true }),
    broadcast: (message: unknown) => sent.push(message),
    cwd: root,
  };
  const send = (message: unknown) => handleMessage(JSON.stringify(message), ctx);
  return { daemon, sent, send, root };
}

const said = (sent: any[], sessionId: string) =>
  sent
    .filter((m) => m.t === "session.event" && m.sessionId === sessionId)
    .map((m) => m.payload?.update?.content?.text)
    .filter(Boolean)
    .join("");

test("a GG agent folds queued messages in mid-run, and gets leftovers as the next turn", async () => {
  const { daemon, sent, root } = await ggDaemon();
  const id = await daemon.startSession("ggcoder", root);
  daemon.markLive(id);

  const steer = daemon.prompt(id, "steer");
  await Bun.sleep(20);
  expect(await daemon.prompt(id, "go left")).toBe("queued");
  await until(() => said(sent, id).includes("steered: go left"), "steered");
  // Logged as the user's turn at the moment it was folded in.
  expect(userMessages(sent).map((m) => m.text)).toEqual(["steer", "go left"]);
  expect(lastQueue(sent).queued).toEqual([]);
  await steer;

  const hold = daemon.prompt(id, "hold");
  await Bun.sleep(20);
  await daemon.prompt(id, "then this");
  await hold;
  expect(said(sent, id)).toContain("heard: then this");
  expect(userMessages(sent).map((m) => m.text)).toEqual(["steer", "go left", "hold", "then this"]);
});

test("ask_user is held like a permission, caught up, and answered", async () => {
  const { daemon, sent, root } = await ggDaemon();
  const id = await daemon.startSession("ggcoder", root);
  daemon.markLive(id);

  const turn = daemon.prompt(id, "ask");
  const ask = await until(
    () => sent.find((m) => m.t === "session.event" && m.payload?.kind === "ask_user")?.payload,
    "ask_user event",
  );
  expect(ask.requestId).toBe("ask_1");
  expect(ask.questions[0]).toMatchObject({ id: "color", kind: "choice" });
  expect(daemon.catchUp({ [id]: 0 })[0]?.asks).toEqual([
    { requestId: "ask_1", questions: ask.questions },
  ]);
  expect(daemon.busyReason()).toBeDefined();
  // An unanswered question pins the session like a permission does.
  expect(daemon.reapIdleSessions(Date.now() + 61 * 60 * 1000)).toEqual([id]);
  await expect(turn).rejects.toBeDefined();
});

test("an answered ask reaches the agent and clears from the catch-up", async () => {
  const { daemon, sent, root } = await ggDaemon();
  const id = await daemon.startSession("ggcoder", root);
  daemon.markLive(id);
  const turn = daemon.prompt(id, "ask");
  await until(() => sent.find((m) => m.payload?.kind === "ask_user"), "ask_user event");

  expect(daemon.answerAsk(id, "ask_1", { action: "answer", answers: { color: "Red" } })).toBe(true);
  await turn;
  expect(said(sent, id)).toContain('answer: {"action":"answer","answers":{"color":"Red"}}');
  expect(daemon.catchUp({ [id]: 0 })[0]?.asks).toEqual([]);
});

test("closing a session answers its open question as cancel", async () => {
  const { daemon, sent, root } = await ggDaemon();
  const id = await daemon.startSession("ggcoder", root);
  daemon.markLive(id);
  const handle = (daemon as any).sessions.get(id).handle as AcpSessionHandle;
  const turn = daemon.prompt(id, "ask").catch(() => "closed");
  await until(() => sent.find((m) => m.payload?.kind === "ask_user"), "ask_user event");

  daemon.closeAll();
  expect(await turn).toBe("closed");
  // Settled by close: nothing is left pending to answer.
  expect(handle.answerAsk("ask_1", { action: "cancel" })).toBe(false);
});

test("goals: list, create, open with a kickoff turn, act, delete", async () => {
  const { daemon, sent, send } = await ggDaemon();

  await send({ t: "goals", requestId: "r1" });
  expect(sent.find((m) => m.t === "goals" && m.requestId === "r1")).toMatchObject({ goals: [] });

  await send({
    t: "goal.create",
    requestId: "r2",
    name: "Ship it",
    goal: "Ship pew2",
    context: ["/tmp"],
  });
  const created = sent.find((m) => m.t === "goal.result" && m.requestId === "r2");
  expect(created).toMatchObject({ ok: true, goal: { name: "Ship it", status: "briefing" } });
  const path = created.goal.path as string;
  // Published, so the app may open a session there.
  expect(await daemon.knownProject("ggcoder", path)).toBe(path);
  expect(
    sent.some((m) => m.t === "goals" && m.requestId === undefined && m.goals.length === 1),
  ).toBe(true);

  await send({ t: "session.start", requestId: "open", providerId: "ggcoder", cwd: path });
  const started = sent.find((m) => m.t === "session.started" && m.requestId === "open");
  expect(started).toBeDefined();
  const id = started.sessionId as string;
  await until(() => sent.find((m) => m.t === "session.idle" && m.sessionId === id), "kickoff idle");
  expect(said(sent, id)).toContain("goalTurn: kickoff");
  // Nobody typed the kickoff.
  expect(userMessages(sent)).toEqual([]);
  const state = sent.findLast((m) => m.t === "goal.state");
  expect(state).toMatchObject({ sessionId: id, goalId: created.goal.id, phase: "active" });
  expect(state.workers[0]).toMatchObject({ id: "w1", state: "running" });
  expect(daemon.catchUp({ [id]: 0 })[0]?.goal).toMatchObject({ goalId: created.goal.id });

  await send({ t: "goals", requestId: "r3" });
  expect(sent.find((m) => m.requestId === "r3").goals[0]).toMatchObject({ sessionId: id });

  await send({
    t: "goal.action",
    requestId: "r4",
    goalId: created.goal.id,
    action: "critterModel",
    model: "fast",
  });
  expect(sent.find((m) => m.requestId === "r4")).toMatchObject({ ok: true });

  await send({ t: "goal.action", requestId: "r5", goalId: created.goal.id, action: "pause" });
  expect(sent.find((m) => m.requestId === "r5")).toMatchObject({
    ok: true,
    goal: { status: "paused" },
  });

  await send({ t: "goal.action", requestId: "r6", goalId: created.goal.id, action: "resume" });
  expect(sent.find((m) => m.requestId === "r6")).toMatchObject({ ok: true });
  await until(() => said(sent, id).includes("goalTurn: resume"), "resume turn");
  expect(userMessages(sent)).toEqual([]);

  await until(
    () => sent.filter((m) => m.t === "session.idle" && m.sessionId === id).length >= 2,
    "resume idle",
  );
  await send({ t: "goal.action", requestId: "r7", goalId: created.goal.id, action: "delete" });
  expect(sent.find((m) => m.requestId === "r7")).toMatchObject({ ok: true });
  expect(sent.findLast((m) => m.t === "goals").goals).toEqual([]);
});

test("goals replaces a parked GG Coder that has exited instead of reusing its closed connection", async () => {
  const { daemon, sent, send } = await ggDaemon();
  await send({ t: "goals", requestId: "r1" });
  expect(sent.find((m) => m.requestId === "r1")).toMatchObject({ goals: [] });

  // The process behind the parked spare dies (a crash, or the checkout it runs
  // from being rebuilt), leaving the spare in place.
  const spares = (daemon as any).spares as Map<string, { handle: AcpSessionHandle }>;
  const parked = [...spares.values()][0]?.handle;
  expect(parked).toBeDefined();
  parked!.child.kill("SIGKILL");
  await until(() => parked!.child.signalCode !== null, "spare exit");

  await send({ t: "goals", requestId: "r2" });
  const answer = sent.find((m) => m.requestId === "r2");
  expect(answer.error).toBeUndefined();
  expect(answer.goals).toEqual([]);
});

test("a capability refresh replacing the parked GG Coder does not kill a goals request running on it", async () => {
  const { daemon, sent, send } = await ggDaemon();
  // Read by the agent at spawn, so set before the first one boots.
  setEnv("PEW2_TEST_GG_LIST_DELAY_MS", "400");
  await send({ t: "goals", requestId: "r1" });
  expect(sent.find((m) => m.requestId === "r1")).toMatchObject({ goals: [] });
  const spares = (daemon as any).spares as Map<string, { handle: AcpSessionHandle }>;
  const parked = [...spares.values()][0]!.handle;

  // The app asks for its goals and refreshes capabilities in the same breath
  // on every reconnect; the refresh boots a new GG Coder and parks it in the
  // same slot, which used to SIGTERM the process the list was running on.
  const listing = send({ t: "goals", requestId: "r2" });
  await Bun.sleep(100);
  await (daemon as any).probeProvider("ggcoder", { refresh: true });
  await listing;
  const answer = sent.find((m) => m.requestId === "r2");
  expect(answer.error ?? answer.message).toBeUndefined();
  expect(answer.goals).toEqual([]);
  // Retired once the request was done with it, not leaked.
  await until(
    () => parked.child.exitCode !== null || parked.child.signalCode !== null,
    "old spare exit",
  );
});

test("an older GG Coder answers goals with an error, not a crash", async () => {
  const { sent, send } = await ggDaemon({ old: true });
  await send({ t: "goals", requestId: "r1" });
  const answer = sent.find((m) => m.t === "goals" && m.requestId === "r1");
  expect(answer.goals).toEqual([]);
  expect(answer.error).toContain("too old");
});

test("without GG Coder installed, goals says so", async () => {
  const { daemon, sent, send } = await ggDaemon();
  (daemon as any).providers = [];
  await send({ t: "goals", requestId: "r1" });
  expect(sent.find((m) => m.t === "goals").error).toContain("isn't installed");
});

test("text GG Coder hands back at turn end that was never ours runs as the next turn", async () => {
  const { daemon, sent } = daemonWithCollector();
  const { session, turns } = plantControlledSession(daemon, "s1");
  (daemon as any).applyAgentQueueUpdate(session, {
    sessionId: "agent-1",
    queued: [],
    returned: [{ id: "late", text: "Red" }],
    turnEnded: true,
  });
  await until(() => turns.length === 1, "returned turn");
  expect(turns[0]!.text).toBe("Red");
  expect(userMessages(sent).map((m) => m.text)).toEqual(["Red"]);
  turns[0]!.finish();
  await until(() => sent.find((m) => m.t === "session.idle"), "idle");
});

test("an open ask outlives its turn, and only pins the session while working", () => {
  const { daemon } = daemonWithCollector();
  const { session } = plantControlledSession(daemon, "s1");
  (session as any).asks = new Map([["ask_1", [{ id: "q", question: "?", kind: "text" }]]]);
  // Still offered after the turn ended.
  expect(daemon.catchUp({ s1: 0 })[0]?.asks).toHaveLength(1);
  expect(daemon.busyReason()).toBeUndefined();
  // Idle with an open ask: ordinary idle rules.
  (session as any).working = true;
  expect(daemon.reapIdleSessions(Date.now() + 20 * 60 * 1000)).toEqual([]);
  (session as any).working = false;
  expect(daemon.reapIdleSessions(Date.now() + 20 * 60 * 1000)).toEqual(["s1"]);
});

test("an ask that stops being open logs ask_user_closed once", async () => {
  const { daemon, sent, root } = await ggDaemon();
  const id = await daemon.startSession("ggcoder", root);
  daemon.markLive(id);
  const turn = daemon.prompt(id, "ask");
  await until(() => sent.find((m) => m.payload?.kind === "ask_user"), "ask_user event");
  daemon.answerAsk(id, "ask_1", { action: "cancel" });
  await turn;
  const closed = () => sent.filter((m) => m.payload?.kind === "ask_user_closed");
  expect(closed().map((m) => m.payload)).toEqual([{ kind: "ask_user_closed", requestId: "ask_1" }]);
  expect(daemon.answerAsk(id, "ask_1", { action: "cancel" })).toBe(false);
  expect(closed()).toHaveLength(1);
});

test("closing a session logs ask_user_closed for its open asks", () => {
  const { daemon, sent } = daemonWithCollector();
  const { session } = plantControlledSession(daemon, "s1");
  (session as any).asks = new Map([["ask_9", []]]);
  daemon.closeAll();
  expect(sent.find((m) => m.payload?.kind === "ask_user_closed")?.payload).toEqual({
    kind: "ask_user_closed",
    requestId: "ask_9",
  });
});

test("plan review: state is live + caught up, a decision is a logged turn, accept resets the agent session", async () => {
  const { daemon, sent, send, root } = await ggDaemon();
  const id = await daemon.startSession("ggcoder", root);
  daemon.markLive(id);
  await daemon.prompt(id, "plan it");
  // Notifications are dispatched beside the prompt's answer, not before it.
  const state = await until(
    () => sent.findLast((m) => m.t === "plan.state" && m.pending),
    "pending plan",
  );
  expect(state).toMatchObject({ sessionId: id, planMode: true, pending: { generation: 1 } });
  expect(daemon.catchUp({ [id]: 0 })[0]?.plan).toEqual(state);

  await send({ t: "plan.decide", sessionId: id, generation: 1, action: "accept" });
  await until(
    () => sent.find((m) => m.t === "session.idle" && said(sent, id).includes("decided")),
    "decided",
  );
  const kinds = sent
    .filter((m) => m.t === "session.event")
    .map((m) => m.payload?.kind)
    .filter(Boolean);
  expect(kinds).toContain("plan_decision");
  const accepted = sent.find((m) => m.payload?.kind === "plan_accepted")?.payload;
  expect(accepted).toEqual({
    kind: "plan_accepted",
    planTotal: 3,
    agentSessionId: daemon.agentSessionId(id),
  });
  expect(daemon.agentSessionId(id)).toEndWith("_impl");
  expect(daemon.catchUp({ [id]: 0 })[0]?.plan?.pending).toBeNull();
  expect(userMessages(sent).map((m) => m.text)).toEqual(["plan it"]);
});

test("autopilot: set round-trips as state, verdicts are logged, checklist answers and nudges", async () => {
  const { daemon, sent, send, root } = await ggDaemon();
  const id = await daemon.startSession("ggcoder", root);
  daemon.markLive(id);
  await send({ t: "autopilot.set", sessionId: id, enabled: true });
  await until(
    () => sent.findLast((m) => m.t === "autopilot.state")?.enabled === true,
    "autopilot state",
  );
  expect(sent.findLast((m) => m.t === "autopilot.state")).toEqual({
    t: "autopilot.state",
    sessionId: id,
    enabled: true,
    reviewing: false,
  });
  expect(daemon.catchUp({ [id]: 0 })[0]?.autopilot?.enabled).toBe(true);

  await daemon.prompt(id, "ken");
  await until(() => sent.find((m) => m.t === "checklist" && m.changed), "checklist nudge");
  await until(
    () => sent.some((m) => m.payload?.kind === "autopilot" && m.payload.phase === "human"),
    "ken verdict",
  );
  const verdicts = sent.filter((m) => m.payload?.kind === "autopilot").map((m) => m.payload);
  expect(verdicts).toEqual([
    { kind: "autopilot", phase: "review_start", round: 1 },
    { kind: "autopilot", phase: "human", reason: "pick a db" },
  ]);
  expect(sent.find((m) => m.t === "checklist" && m.changed)).toEqual({
    t: "checklist",
    sessionId: id,
    changed: true,
  });

  await send({ t: "checklist", requestId: "c1", sessionId: id });
  const answer = sent.find((m) => m.t === "checklist" && m.requestId === "c1");
  expect(answer).toMatchObject({
    staleAfterDays: 30,
    items: [{ id: "tests", status: "passed", runPrompt: "check tests" }],
  });
  const caps = await daemon.capabilitiesFor("ggcoder");
  expect(caps.extensions).toMatchObject({ planReview: true, autopilot: true, checklist: true });
});

test("extensions seen on any connection fill a capabilities answer that lost the probe race", async () => {
  const { daemon } = daemonWithCollector();
  const caps = { configOptions: [], sessions: [], canResume: true, projects: [], commands: [] };
  (daemon as any).probeProvider = async () => caps;
  expect((await daemon.capabilitiesFor("ggcoder")).extensions).toBeUndefined();
  (daemon as any).noteExtensions("ggcoder", { ggCapabilities: { autopilot: 1, checklist: 1 } });
  expect((await daemon.capabilitiesFor("ggcoder")).extensions).toEqual({
    autopilot: true,
    checklist: true,
    tasks: true,
  });
  // The probe's own answer still wins when it has one.
  (daemon as any).probeProvider = async () => ({ ...caps, extensions: { goals: true } });
  expect((await daemon.capabilitiesFor("ggcoder")).extensions).toEqual({ goals: true });
});

test("gg-goals: goal sessions split from ggcoder, goal cwd required, no autopilot", async () => {
  const { daemon, sent, send, root } = await ggDaemon();
  setEnv("GG_AGENT_DIR", root);
  (daemon as any).providers = [
    ggProvider,
    { ...ggProvider, manifest: { ...ggProvider.manifest, id: "gg-goals", name: "GG Goals" } },
  ];
  const gg = await daemon.capabilitiesFor("ggcoder");
  expect(gg.sessions.map((s) => s.sessionId)).toEqual(["plain_1"]);
  const goals = await daemon.capabilitiesFor("gg-goals");
  expect(goals.sessions.map((s) => s.sessionId)).toEqual(["goal_1"]);
  expect(goals.projects).toEqual([]);
  expect(goals.extensions).toEqual({ queue: true, askUser: true, goals: true });
  // GG Coder's newest session is a goal's: its default project must still be
  // a GG Coder one, never the goal folder.
  expect(await daemon.lastWorkspace("ggcoder")).toBe(root);

  await send({ t: "session.start", requestId: "x", providerId: "gg-goals", cwd: root });
  expect(sent.find((m) => m.t === "error" && m.code === "not_a_goal")).toBeDefined();
  expect(sent.some((m) => m.t === "session.started" && m.requestId === "x")).toBe(false);

  await send({ t: "goal.create", requestId: "c", name: "Ship it", goal: "Ship", context: [] });
  const path = sent.find((m) => m.t === "goal.result" && m.requestId === "c").goal.path as string;
  await send({ t: "session.start", requestId: "o", providerId: "gg-goals", cwd: path });
  const started = await until(
    () => sent.find((m) => m.t === "session.started" && m.requestId === "o"),
    "start",
  );
  await send({ t: "autopilot.set", sessionId: started.sessionId, enabled: true });
  expect(sent.some((m) => m.t === "autopilot.state" && m.sessionId === started.sessionId)).toBe(
    false,
  );
  setEnv("GG_AGENT_DIR", undefined);
});

/** A GG Coder session in a project whose task file holds `tasks`. */
async function ggTaskSession(tasks: object[]) {
  const harness = await ggDaemon();
  const id = await harness.daemon.startSession("ggcoder", harness.root);
  harness.daemon.markLive(id);
  const base = join(harness.root, "gg-tasks");
  (harness.daemon as any).ggTasksBase = base;
  const path = taskFilePath(base, (harness.daemon as any).sessions.get(id).cwd);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(tasks));
  return { ...harness, id, path };
}

test("tasks: a GG Coder session lists its project's tasks with their run prompts", async () => {
  const { sent, send, id } = await ggTaskSession([
    { id: "aaaaaaaa-1", title: "Fix login", prompt: "fix it", status: "pending" },
    { id: "bbbbbbbb-2", title: "Docs", prompt: "write docs", status: "done" },
  ]);
  await send({ t: "tasks", requestId: "t1", sessionId: id });
  const listed = sent.find((m) => m.t === "tasks" && m.requestId === "t1");
  expect(listed).toMatchObject({ sessionId: id, replied: true });
  expect(listed.items.map((t: any) => [t.id, t.status, t.runPrompt !== null])).toEqual([
    ["aaaaaaaa-1", "pending", true],
    ["bbbbbbbb-2", "done", false],
  ]);
  expect(listed.items[0].runPrompt).toStartWith("fix it\n\n---");
  expect(listed.items[0].runPrompt).toEndWith('tasks({ action: "done", id: "aaaaaaaa" })');
});

test("tasks: task.start runs the task in the same chat on a fresh agent context", async () => {
  const { daemon, sent, send, id, path } = await ggTaskSession([
    { id: "aaaaaaaa-1", title: "Fix login", prompt: "fix it", status: "pending", createdAt: "x" },
  ]);
  const before = daemon.agentSessionId(id);
  expect(before).toStartWith("gg_");

  await send({ t: "task.start", requestId: "t1", sessionId: id, taskId: "aaaaaaaa-1" });
  const started = sent.find((m) => m.t === "tasks" && m.requestId === "t1");
  expect(started.error).toBeUndefined();
  expect(started.items[0]).toMatchObject({ status: "in-progress", runPrompt: null });
  // The test agent asks a question for any prompt containing "ask", which "tasks(" does.
  const ask = await until(
    () => sent.find((m) => m.t === "session.event" && m.payload?.kind === "ask_user"),
    "ask",
  );
  daemon.answerAsk(id, ask.payload.requestId, { action: "cancel" });
  await until(() => sent.find((m) => m.t === "session.idle" && m.sessionId === id), "task idle");

  // The same pew2 conversation, now on a new agent session.
  expect((daemon as any).sessions.size).toBe(1);
  expect(sent.filter((m) => m.t === "session.started")).toHaveLength(0);
  const after = daemon.agentSessionId(id);
  expect(after).toStartWith("gg_");
  expect(after).not.toBe(before);

  const events = sent.filter((m) => m.t === "session.event" && m.sessionId === id);
  const reset = events.findIndex((m) => m.payload?.kind === "context_reset");
  expect(events[reset]?.payload).toEqual({
    kind: "context_reset",
    reason: "task",
    title: "Fix login",
    agentSessionId: after,
  });
  // The task prompt reached the new session, after the marker, with no user bubble.
  const heard = events.findIndex((m) => m.payload?.update?.content?.text?.startsWith("heard: "));
  expect(heard).toBeGreaterThan(reset);
  expect(events[heard].payload.sessionId).toBe(after);
  expect(events[heard].payload.update.content.text).toStartWith("heard: fix it");
  expect(userMessages(sent)).toEqual([]);

  expect(JSON.parse(await readFile(path, "utf8"))).toEqual([
    {
      id: "aaaaaaaa-1",
      title: "Fix login",
      prompt: "fix it",
      status: "in-progress",
      createdAt: "x",
    },
  ]);
});

test("tasks: task.start closes a question the old context left open", async () => {
  const { daemon, sent, send, id } = await ggTaskSession([
    { id: "aaaaaaaa-1", title: "Fix login", prompt: "fix it", status: "pending" },
  ]);
  const session = (daemon as any).sessions.get(id);
  session.asks = new Map([["ask_old", []]]);

  await send({ t: "task.start", requestId: "t1", sessionId: id, taskId: "aaaaaaaa-1" });
  const ask = await until(
    () => sent.find((m) => m.t === "session.event" && m.payload?.kind === "ask_user"),
    "ask",
  );
  daemon.answerAsk(id, ask.payload.requestId, { action: "cancel" });
  await until(() => sent.find((m) => m.t === "session.idle" && m.sessionId === id), "task idle");

  expect(
    sent.find(
      (m) =>
        m.t === "session.event" &&
        m.payload?.kind === "ask_user_closed" &&
        m.payload.requestId === "ask_old",
    )?.payload,
  ).toEqual({ kind: "ask_user_closed", requestId: "ask_old" });
  expect(session.asks.has("ask_old")).toBe(false);
});

test("tasks: task.start is refused while working or for a task not to do, file untouched", async () => {
  const { daemon, sent, send, id, path } = await ggTaskSession([
    { id: "aaaaaaaa-1", title: "Fix login", prompt: "fix it", status: "pending" },
    { id: "bbbbbbbb-2", title: "Docs", prompt: "write docs", status: "done" },
    { id: "cccccccc-3", title: "Run", prompt: "run it", status: "in-progress" },
  ]);
  const file = await readFile(path, "utf8");
  const before = daemon.agentSessionId(id);
  const answer = (requestId: string) =>
    sent.find((m) => m.t === "tasks" && m.requestId === requestId);

  const hold = daemon.prompt(id, "hold");
  await Bun.sleep(20);
  await send({ t: "task.start", requestId: "busy", sessionId: id, taskId: "aaaaaaaa-1" });
  expect(answer("busy")).toMatchObject({
    error: "The agent is still working; run the task when it stops.",
  });
  await hold;

  await send({ t: "task.start", requestId: "done", sessionId: id, taskId: "bbbbbbbb-2" });
  expect(answer("done")).toMatchObject({ error: "That task is already done." });
  await send({ t: "task.start", requestId: "running", sessionId: id, taskId: "cccccccc-3" });
  expect(answer("running")).toMatchObject({ error: "That task is already running." });
  await send({ t: "task.start", requestId: "gone", sessionId: id, taskId: "gone" });
  expect(answer("gone")).toMatchObject({ error: "That task no longer exists." });

  for (const id of ["busy", "done", "running", "gone"]) expect(answer(id).items).toBeUndefined();
  expect(await readFile(path, "utf8")).toBe(file);
  expect(daemon.agentSessionId(id)).toBe(before);
  expect(sent.some((m) => m.payload?.kind === "context_reset")).toBe(false);
});

test("tasks: any other agent's session is refused with an error, not a list", async () => {
  const { daemon, sent, send } = await ggDaemon();
  plantControlledSession(daemon, "s1");
  await send({ t: "tasks", requestId: "t1", sessionId: "s1" });
  const answer = sent.find((m) => m.t === "tasks" && m.requestId === "t1");
  expect(answer).toMatchObject({ sessionId: "s1", error: "Tasks are for GG Coder conversations." });
  expect(answer.items).toBeUndefined();
});
