/**
 * What the phone can ask of the daemon: the prompt path shared by every send,
 * and the actions object `useDaemon` returns (start, prompt, cancel, open,
 * select, leave, images, goals…). Moved out of the hook unchanged; the hook
 * still memoizes them on the same dependencies.
 */
import { needsResume } from "./agentHistory";
import { receiptOnOpen } from "./turnReceipts";
import { isPendingSession, pendingSession, pendingSessionKey } from "./pendingSession";
import { enqueue, pendingStartFor } from "./outbox";
import { withChoice } from "./configTruth";
import { beginActivity, IDLE_ACTIVITY } from "./activity";
import {
  attachmentImages,
  toWireAttachments,
  type PendingAttachment,
  type WireAttachment,
} from "./attachments";
import { capTurns } from "./replayFold";
import { closeAsk, dropQueued, markTaskStarted } from "./ggState";
import { decidedPlan, type PlanInfo } from "./ggReview";
import { sendsToQueue } from "./queue";
import type { AskResult } from "./askUser";
import { isFixtureSession } from "./fixtures";
import { restoreTarget } from "./restoreState";
import type { Session } from "./daemonTypes";
import { localTurn, stoppedBeforeSend } from "./daemonState";
import type { DaemonRefs } from "./daemonContext";

function withPlan(
  plans: Record<string, PlanInfo>,
  id: string,
  plan: PlanInfo | undefined,
): Record<string, PlanInfo> {
  return plan ? { ...plans, [id]: plan } : plans;
}

/** Send one sealed message; false when nothing was sent. */
export type Post = (message: unknown) => boolean;

/** The hook's refs and setters the prompt path reads and writes. */
export type DeliverRefs = Pick<
  DaemonRefs,
  "localSeq" | "outbox" | "sessionRef" | "setState" | "viewingRef"
>;

/**
 * Send a prompt, or hold it until there is a socket to send it on.
 *
 * The one place a user message becomes a turn, shared by the two ways of
 * sending one: into an open conversation, and into a conversation that has
 * been asked for but not yet named. Both can be offline, and the difference
 * shows only in what the bubble says about itself — the message is rendered
 * either way, and `flushOutbox` delivers it when the signal returns.
 *
 * Returns false only when the message is genuinely not taken: the queue is
 * full. The composer keeps the words in that case rather than clearing a
 * message that is going nowhere.
 */
export function deliverPrompt(
  refs: DeliverRefs,
  post: Post,
  sessionId: string,
  text: string,
  attachments: readonly PendingAttachment[],
): boolean {
  const { localSeq, outbox, sessionRef, setState, viewingRef } = refs;
  // Attempted first, because its answer decides everything below. A
  // conversation with no id yet cannot be addressed at all, so it does not
  // even try: `session.started` re-addresses this entry later.
  const wire = toWireAttachments(attachments);
  const sent =
    !isPendingSession(sessionId) &&
    post({ t: "session.prompt", sessionId, text, attachments: wire });
  const turn = localTurn(localSeq.current++, text, attachmentImages(attachments), !sent);
  if (!sent) {
    const queue = enqueue(outbox.current, {
      kind: "prompt",
      turnKey: turn.key!,
      sessionId,
      text,
      attachments: wire,
    });
    if (!queue) return false;
    outbox.current = queue;
  }
  const started = Date.now();
  // The conversation on screen, whether it has an id yet or not.
  const visible =
    sessionId === sessionRef.current ||
    (isPendingSession(sessionId) && sessionId === viewingRef.current);
  setState((s) => {
    // Sent into a running turn: the daemon queues it, the strip above the
    // composer shows it, and it reaches the transcript as a logged
    // `user_message` when the agent reads it. No bubble, no new clock.
    const targetBusy = visible
      ? s.busy
      : s.sessions.find((session) => session.id === sessionId)?.busy === true;
    if (sendsToQueue({ sent, busy: targetBusy, loading: visible && s.loadingSession })) return s;
    return {
      ...s,
      // Nothing is working while a message waits for a socket, so nothing
      // spins and no clock runs. Both start in `flushOutbox`, at the moment
      // the message actually leaves the phone.
      busy: visible && sent ? true : s.busy,
      // Whatever this conversation was still loading, it is now carrying a
      // prompt the user just sent. `loadingSession` suppresses the working
      // indicator entirely, so leaving it set showed an empty transcript
      // under the message for as long as the agent took to attach — the
      // one moment the user most needs to see that something is happening.
      loadingSession: visible ? false : s.loadingSession,
      // A prompt sent to another conversation is not what this transcript
      // is showing, so the line under it keeps describing this one.
      activity: visible && sent ? beginActivity(started) : s.activity,
      receipt: visible && sent ? undefined : s.receipt,
      turns: visible ? capTurns([...s.turns, turn]) : s.turns,
      sessions: s.sessions.map((session) =>
        session.id === sessionId
          ? {
              ...session,
              turns: capTurns([...session.turns, turn]),
              // Marked working here, not on the first streamed chunk:
              // an agent can think for a long time before it says
              // anything, and the drawer should show that as work.
              busy: sent ? true : session.busy,
              unread: false,
              title: session.title === "New conversation" ? turn.text.slice(0, 60) : session.title,
            }
          : session,
      ),
    };
  });
  return true;
}

/** The hook's refs and setters the actions read and write. */
export type ActionRefs = Pick<
  DaemonRefs,
  | "awaitingResume"
  | "browseCounter"
  | "browseRequest"
  | "clearImages"
  | "goalCounter"
  | "liveSessions"
  | "localSeq"
  | "outbox"
  | "pendingStart"
  | "projectRef"
  | "providerRef"
  | "queued"
  | "requestedImages"
  | "restoring"
  | "sessionRef"
  | "sessionsRef"
  | "setGg"
  | "setKnownConfigs"
  | "setState"
  | "streamBoundary"
  | "targetProviderRef"
  | "viewingRef"
>;

export interface ActionDeps {
  post: Post;
  deliverPrompt: (
    sessionId: string,
    text: string,
    attachments: readonly PendingAttachment[],
  ) => boolean;
  sendImageRequest: (uri: string) => void;
  deviceId: string;
}

export function createActions(refs: ActionRefs, deps: ActionDeps) {
  const {
    awaitingResume,
    browseCounter,
    browseRequest,
    clearImages,
    goalCounter,
    liveSessions,
    localSeq,
    outbox,
    pendingStart,
    projectRef,
    providerRef,
    queued,
    requestedImages,
    restoring,
    sessionRef,
    sessionsRef,
    setGg,
    setKnownConfigs,
    setState,
    streamBoundary,
    targetProviderRef,
    viewingRef,
  } = refs;
  const { post, deliverPrompt, sendImageRequest, deviceId } = deps;
  return {
    /**
     * `initialText` and its attachments are sent automatically once the
     * session is ready.
     */
    start: (
      providerId: string,
      initialText?: string,
      attachments: readonly PendingAttachment[] = [],
    ): boolean => {
      const started = Date.now();
      // A conversation with this agent already asked for and still waiting for
      // a socket: this message joins it instead of opening a second one.
      // Offline that is the ordinary case rather than a race — without it,
      // every message typed in a tunnel would open its own thread and spawn
      // its own agent the moment the signal came back.
      const waiting = initialText ? pendingStartFor(outbox.current, providerId) : undefined;
      if (waiting) {
        return deliverPrompt(pendingSessionKey(waiting.requestId), initialText!, attachments);
      }
      queued.current = initialText ? { text: initialText, attachments } : undefined;
      // Named, so the answer can be matched to this request rather than to
      // whichever `session.started` happens to arrive next: the daemon
      // broadcasts them to every client, and another device starting a
      // conversation at the same moment would otherwise be adopted here.
      //
      // Carries the device id because that is the part no other client can
      // repeat. A counter and a clock alone are per-app values, and two
      // phones opening their first conversation in the same millisecond would
      // mint the same string — which is the one case this id exists to tell
      // apart.
      const requestId = `start:${deviceId}:${localSeq.current++}:${started}`;
      pendingStart.current = requestId;
      viewingRef.current = pendingSessionKey(requestId);
      // A chosen project is where this conversation opens. Without it the
      // daemon falls back to the agent's last workspace, which is the whole
      // reason picking a project from the phone was impossible before.
      const cwd = projectRef.current[providerId];
      const sent = post({ t: "session.start", requestId, providerId, cwd });
      // Spawning the agent and its ACP handshake take seconds; without a local
      // turn the screen would sit empty and look like the send did nothing.
      const turn = initialText
        ? localTurn(localSeq.current++, initialText, attachmentImages(attachments), !sent)
        : undefined;
      if (!sent) {
        // The first message is queued against the request rather than held in
        // `queued`, which is only delivered when the answer lands on the
        // conversation the user is looking at. Across a reconnect that is a
        // long time to still be standing in the same place — open another
        // conversation meanwhile and the message would be adopted into the
        // new row and then never sent. See `QueuedStart`.
        queued.current = undefined;
        const request = enqueue(outbox.current, { kind: "start", requestId, providerId, cwd });
        const queue =
          request && turn
            ? enqueue(request, {
                kind: "prompt",
                turnKey: turn.key!,
                sessionId: pendingSessionKey(requestId),
                text: initialText!,
                attachments: toWireAttachments(attachments),
              })
            : request;
        // Both or neither: a request queued without the message it exists to
        // carry would open an empty conversation on reconnect.
        if (!queue) return false;
        outbox.current = queue;
      }
      restoring.current = undefined;
      awaitingResume.current = false;
      setState((s) => ({
        ...s,
        restoreTarget: undefined,
        restoreError: undefined,
        busy: turn !== undefined && sent,
        loadingSession: false,
        turns: turn ? capTurns([...s.turns, turn]) : s.turns,
        // The clock starts when the prompt leaves the phone, not when the
        // agent first speaks: booting the agent is part of the wait. A prompt
        // still waiting for a socket has not left the phone, and its clock
        // starts in `flushOutbox` instead.
        activity: turn && sent ? beginActivity(started) : s.activity,
        receipt: undefined,
        // The conversation exists as far as the user is concerned — they
        // just started it — so it is in the drawer from here, carrying the
        // prompt, and `session.started` adopts this row rather than creating
        // its own. Leaving the list untouched until the answer arrived is
        // what made a conversation vanish when the reply was slow and the
        // user moved on: it was running on the desktop with nothing on the
        // phone pointing at it. See `pendingSession`.
        sessions: [
          {
            ...pendingSession(requestId, providerId, initialText, started, cwd),
            // A conversation whose request is still queued is not working:
            // nothing has been asked of anything yet.
            busy: turn !== undefined && sent,
            turns: turn ? [turn] : [],
          },
          ...s.sessions,
        ],
      }));
      return true;
    },

    /**
     * Send a prompt.
     *
     * `to` names a conversation other than the one on screen, which is how a
     * reply typed into a notification reaches the agent it answers without
     * yanking the user into that thread. The optimistic turn is then only
     * recorded against that session, never the visible transcript — putting
     * it there would show a message from another project in this one.
     *
     * `attachments` are inlined into the message; the daemon writes them to
     * its own disk and hands the agent a path it can actually open.
     *
     * @returns false when the conversation must be reloaded first — a daemon
     * restart drops its session ids, and prompting one it no longer holds
     * answers "Unknown session". The caller still has the text and can open
     * the conversation instead of losing it.
     */
    prompt: (
      text: string,
      to?: string,
      attachments: readonly PendingAttachment[] = [],
    ): boolean => {
      const sessionId = to ?? sessionRef.current;
      if (!sessionId) return false;
      if (to && to !== sessionRef.current) {
        const target = sessionsRef.current.find((entry) => entry.id === to);
        if (!target || needsResume(target, liveSessions.current)) return false;
      }
      return deliverPrompt(sessionId, text, attachments);
    },

    cancel: () => {
      streamBoundary.current?.();
      const sessionId = sessionRef.current;
      if (sessionId) {
        post({ t: "session.cancel", sessionId });
        // No receipt for a turn the user stopped: it did not finish, and
        // reporting what it managed first would read as a result.
        setState((s) => ({ ...s, busy: false, activity: IDLE_ACTIVITY, receipt: undefined }));
        return;
      }

      // Stop pressed while the agent is still booting. The first prompt of a
      // conversation is not sent yet — it is held in `queued` until
      // `session.started` names a session to send it to — so there is nothing
      // for the daemon to cancel, and dropping the queued text *is* the
      // cancel. Without this the prompt went out the moment the session
      // opened, and Stop appeared to work only on the second press.
      const pending = queued.current;
      queued.current = undefined;
      // Built out here, not in the updater: React may invoke an updater twice,
      // and `localSeq.current++` inside one would hand two turns the same id.
      const note = pending ? stoppedBeforeSend(localSeq.current++) : undefined;
      setState((s) => ({
        ...s,
        busy: false,
        activity: IDLE_ACTIVITY,
        receipt: undefined,
        // The prompt is still on screen but the agent never saw it: say so,
        // rather than leaving it looking like a message that was ignored.
        turns: note ? [...s.turns, note] : s.turns,
      }));
    },

    /** Withdraw one queued message before the agent reads it. */
    cancelQueued: (sessionId: string, id: string) => {
      if (post({ t: "session.queue.cancel", sessionId, id })) {
        setGg((g) => dropQueued(g, sessionId, id));
      }
    },

    /** Answer (or dismiss, with `{action:"cancel"}`) an open `ask_user`. */
    answerAsk: (sessionId: string, requestId: string, result: AskResult) => {
      post({ t: "session.ask", sessionId, requestId, result });
      setGg((g) => closeAsk(g, sessionId, requestId));
    },

    /** Decide a pending plan (GG Coder plan review). */
    decidePlan: (
      sessionId: string,
      generation: number,
      action: "accept" | "feedback" | "reject",
      feedback?: string,
    ) => {
      const frame = {
        t: "plan.decide",
        sessionId,
        generation,
        action,
        ...(feedback ? { feedback } : {}),
      };
      if (post(frame))
        setGg((g) => ({
          ...g,
          plans: withPlan(g.plans, sessionId, decidedPlan(g.plans[sessionId], generation)),
        }));
    },

    /** Turn Autopilot (Ken) on or off for this session's project. */
    setAutopilot: (sessionId: string, enabled: boolean) => {
      if (post({ t: "autopilot.set", sessionId, enabled })) {
        setGg((g) => ({
          ...g,
          autopilot: {
            ...g.autopilot,
            [sessionId]: { enabled, reviewing: g.autopilot[sessionId]?.reviewing ?? false },
          },
        }));
      }
    },

    /** Ask for the project checklist of an open GG Coder session. */
    requestChecklist: (sessionId: string) => {
      post({ t: "checklist", requestId: `checklist_${++goalCounter.current}`, sessionId });
    },

    /** Ask for the task list of an open GG Coder session's project. */
    requestTasks: (sessionId: string) => {
      post({ t: "tasks", requestId: `tasks_${++goalCounter.current}`, sessionId });
    },

    /** Run a task in this chat on a fresh context. Returns the request id to watch in `tasks`, or undefined when nothing could be sent. */
    startTask: (sessionId: string, taskId: string): string | undefined => {
      const requestId = `tasks_${++goalCounter.current}`;
      if (!post({ t: "task.start", requestId, sessionId, taskId })) return undefined;
      setGg((g) => markTaskStarted(g, sessionId, taskId));
      return requestId;
    },

    /** Ask for the goal list (GG Coder). */
    refreshGoals: () => {
      const requestId = `goals_${++goalCounter.current}`;
      if (post({ t: "goals", requestId })) setGg((g) => ({ ...g, goalsLoading: true }));
    },

    /** Create a goal. Returns the request id to watch in `goalResults`. */
    createGoal: (input: {
      name: string;
      goal: string;
      context: string[];
      instructions?: string;
      files?: WireAttachment[];
    }): string | undefined => {
      const requestId = `goal_${++goalCounter.current}`;
      return post({ t: "goal.create", requestId, ...input }) ? requestId : undefined;
    },

    /** Pause, resume, delete, update or set the critter model of a goal. */
    goalAction: (
      goalId: string,
      action: "delete" | "pause" | "resume" | "update" | "critterModel",
      extra: { context?: string[]; instructions?: string; model?: string | null } = {},
    ): string | undefined => {
      const requestId = `goal_${++goalCounter.current}`;
      const sent = post({ t: "goal.action", requestId, goalId, action, ...extra });
      if (sent && action === "delete") {
        setGg((g) => ({ ...g, goals: g.goals?.filter((goal) => goal.id !== goalId) }));
      }
      return sent ? requestId : undefined;
    },

    answer: (requestId: string, optionId: string) => {
      const sessionId = sessionRef.current;
      if (sessionId) post({ t: "session.permission", sessionId, requestId, optionId });
      setState((s) => ({
        ...s,
        permission: undefined,
        busy: true,
        // Cleared on the conversation too, or reopening it would offer the
        // same approval again and the second answer would land on a request
        // the agent has already been let past.
        sessions: s.sessions.map((session) =>
          session.id === sessionId && session.permission
            ? { ...session, permission: undefined }
            : session,
        ),
      }));
    },

    /** Change a model, thinking level or mode on the open session. */
    setConfig: (configId: string, value: string | boolean) => {
      streamBoundary.current?.();
      const sessionId = sessionRef.current;
      const providerId = providerRef.current ?? targetProviderRef.current;
      // Chosen in a live conversation or in the empty state, this is now what
      // the *next* conversation opens with too: the daemon records either
      // against the provider. Applied locally so the empty state is already
      // right the moment you leave this one, rather than a round trip later.
      if (providerId) {
        setKnownConfigs((known) => ({
          ...known,
          [providerId]: withChoice(known[providerId] ?? [], configId, value),
        }));
      }
      if (sessionId) {
        post({ t: "session.config", sessionId, configId, value });
        return;
      }

      // Nothing to set it on yet: a conversation is only created by its first
      // prompt, so before then the daemon holds the choice against the
      // provider and the new session opens with it applied. Without this the
      // pill in the empty state silently did nothing until you had sent a
      // message — the one moment you are most likely to be choosing a model.
      if (!providerId) return;
      post({ t: "provider.config", providerId, configId, value });
    },

    /** Reopen a past conversation from the sidebar. */
    openSession: (sessionId: string) => {
      streamBoundary.current?.();
      const remembered = restoring.current?.id === sessionId ? restoring.current : undefined;
      const session: Session | undefined =
        sessionsRef.current.find((entry) => entry.id === sessionId) ??
        (remembered ? { ...remembered, startedAt: 0, turns: [], configOptions: [] } : undefined);
      if (!session) return;

      // A conversation from the agent's own history has no turns here yet:
      // they live on the agent's disk and stream back as ordinary events once
      // it loads. Show the agent and wait rather than rendering it empty.
      //
      // A session this app started is shown from memory instead — unless the
      // daemon no longer holds it. See `needsResume`.
      if (remembered || needsResume(session, liveSessions.current)) {
        const target = restoreTarget(session);
        restoring.current = target;
        sessionRef.current = undefined;
        // The row being reopened, even though it has no session id until the
        // daemon answers: this is the screen, and a `session.started` for
        // something else must not land on it.
        viewingRef.current = sessionId;
        awaitingResume.current = true;
        providerRef.current = session.providerId;
        queued.current = undefined;
        post({
          t: "session.resume",
          providerId: session.providerId,
          agentSessionId: session.agentSessionId,
          cwd: session.cwd,
        });
        setState((s) => ({
          ...s,
          sessionId: undefined,
          activeProviderId: session.providerId,
          workspace: undefined,
          // Belongs to the conversation being left: a context reading is about one
          // agent's window, and carrying it across would put the previous chat's
          // percentage beside this one's project.
          usage: undefined,
          turns: [],
          configOptions: [],
          // Cleared so the previous conversation's menu is not offered for
          // this one; the provider's own list below fills it back in.
          commands: [],
          // A reopen is a new agent session, so nothing can be pending in it
          // yet — and the sheet being left behind belongs to a request in the
          // conversation being left, which this screen must not answer.
          permission: undefined,
          busy: true,
          loadingSession: true,
          restoreTarget: target,
          restoreError: undefined,
          // Both describe the conversation being left.
          activity: IDLE_ACTIVITY,
          receipt: undefined,
          sessions: s.sessions.map((entry) =>
            // Its approval goes with it: a resume means the daemon no longer
            // holds that session, so the request it was blocked on died with
            // the old agent and the button would post an id into nothing.
            entry.id === sessionId ? { ...entry, unread: false, permission: undefined } : entry,
          ),
        }));
        return;
      }

      restoring.current = undefined;
      // Fixture transcripts exist only on this device, so they must never
      // become the target of a prompt, cancel or config change: the daemon
      // has never heard of them and those messages would vanish silently.
      // Opening one shows its history and selects its agent; typing then
      // starts a real session instead of posting against a phantom id.
      //
      // A conversation still waiting for its `session.started` is the same
      // case for the same reason — the daemon has not named it yet, so there
      // is no id to address — with the difference that this one becomes real
      // shortly. Opening it shows the prompt already sent, and the answer
      // lands in this transcript anyway, because `session.started` sets
      // `sessionId` regardless of what is on screen.
      const live = !isFixtureSession(sessionId) && !isPendingSession(sessionId);
      sessionRef.current = live ? sessionId : undefined;
      viewingRef.current = sessionId;
      // Opening this one withdraws the claim of a reopen still in flight. A
      // resume does not block the drawer, so tapping a second conversation
      // while the first is still attaching is ordinary — and without this the
      // first one's answer would arrive, still count as "mine", and pull the
      // user back out of the conversation they just chose.
      awaitingResume.current = false;
      providerRef.current = session.providerId;
      queued.current = undefined;
      setState((s) => ({
        ...s,
        sessionId: live ? sessionId : undefined,
        activeProviderId: session.providerId,
        // Another conversation can be in another project entirely. The nonce
        // covers the case this branch also serves: opening a *fixture* leaves
        // `sessionId` and the provider exactly as they were, so without it the
        // row stays blank rather than coming back.
        workspace: undefined,
        // This conversation's own last reading (the one on screen belongs to
        // the chat being left). Absent until it has reported one.
        usage: s.sessions.find((row) => row.id === sessionId)?.usage,
        workspaceNonce: s.workspaceNonce + 1,
        turns: s.sessions.find((row) => row.id === sessionId)?.turns ?? session.turns,
        restoreTarget: undefined,
        restoreError: undefined,
        configOptions: session.configOptions,
        // This conversation's own state, not a reset: it may still be
        // mid-turn on the desktop, and clearing the spinner here would show
        // a running agent as finished.
        busy: session.busy === true,
        // Same rule, and the reason it is kept per session: an agent stopped
        // waiting for approval is what the user came back to deal with. The
        // previous conversation's sheet goes with it — answering that one
        // from here posted the wrong session's request id, which the daemon
        // dropped in silence.
        permission: session.permission,
        loadingSession: false,
        // A conversation still running elsewhere has tools this client never
        // saw, so there is no live line to restore.
        activity: IDLE_ACTIVITY,
        // Its last finished turn's summary, though, is a fact about that
        // turn and is restored with it.
        receipt: receiptOnOpen(session),
        // Reading it is what makes it read.
        sessions: s.sessions.map((entry) =>
          entry.id === sessionId ? { ...entry, unread: false } : entry,
        ),
      }));
    },

    /**
     * Narrow the drawer to one project, and start the next conversation in
     * it. `path` undefined is "all projects", the state every agent opens in.
     *
     * Asks the daemon for that project's conversations as well as filtering
     * what is already here: the history this client holds is the newest work
     * across every project, so a project last touched a month ago has none
     * of its own rows in it.
     */
    selectProject: (providerId: string, path?: string) => {
      if (path) projectRef.current = { ...projectRef.current, [providerId]: path };
      else {
        const { [providerId]: _dropped, ...rest } = projectRef.current;
        projectRef.current = rest;
      }
      setState((s) => ({
        ...s,
        projectPath: path
          ? { ...s.projectPath, [providerId]: path }
          : Object.fromEntries(Object.entries(s.projectPath).filter(([id]) => id !== providerId)),
        // Any fetch still in flight is for the project just left, so its
        // skeleton no longer describes this list. Back to "all projects"
        // especially: nothing is being fetched at all, and leaving this set
        // would hold the drawer in a skeleton over history it already has.
        loadingProject: undefined,
      }));
      // The request itself is an effect below, so a project chosen while
      // offline is still asked for the moment the socket comes back.
    },

    /**
     * Look on the desktop for somewhere to work.
     *
     * Call with no path for the opening view — git checkouts the daemon found
     * — and with one to browse into a directory. This is the only route into
     * an agent that has never been used: its project list comes from its own
     * past sessions, so a new agent offers nothing to pick.
     */
    browseWorkspaces: (path?: string, options?: { files?: boolean }) => {
      // Monotonic, and compared on arrival: two listings can be in flight at
      // once if the user taps quickly, and only the newest may render.
      const requestId = `ws_${++browseCounter.current}`;
      browseRequest.current = requestId;

      const sent = post({
        t: "workspaces",
        requestId,
        path,
        ...(options?.files ? { files: true } : {}),
      });
      setState((s) => ({
        ...s,
        browse: {
          // The previous listing is kept underneath the spinner rather than
          // cleared: blanking the list on every tap makes the picker flash
          // empty between levels.
          path: path ?? s.browse?.path,
          parent: s.browse?.parent,
          entries: s.browse?.entries ?? [],
          loading: sent,
          // Not a refusal — the request never reached the daemon. The picker
          // shows the offline case from `status`, which is already on screen.
          refused: false,
          unsent: !sent,
        },
      }));
    },

    /** Choose which agent the composer targets. Ends any open session. */
    select: (providerId: string) => {
      streamBoundary.current?.();
      restoring.current = undefined;
      sessionRef.current = undefined;
      viewingRef.current = undefined;
      // Choosing an agent ends the open session, so a reopen still in flight
      // has nothing left to come back to. Same reasoning as `leave`.
      awaitingResume.current = false;
      providerRef.current = providerId;
      queued.current = undefined;
      // The pictures belong to the transcript being closed, and they are the
      // largest thing this hook holds. See `imageCache.ts`.
      clearImages();
      setState((s) => ({
        ...s,
        activeProviderId: providerId,
        sessionId: undefined,
        workspace: undefined,
        // Belongs to the conversation being left: a context reading is about one
        // agent's window, and carrying it across would put the previous chat's
        // percentage beside this one's project.
        usage: undefined,
        turns: [],
        // Selectors belong to the old agent's session; keeping them would
        // show another agent's model name in the top bar. Its slash commands
        // are wrong here for the same reason.
        configOptions: [],
        commands: [],
        busy: false,
        loadingSession: false,
        restoreTarget: undefined,
        restoreError: undefined,
        activity: IDLE_ACTIVITY,
        receipt: undefined,
      }));
    },

    /**
     * Ask the daemon for an image the agent named by path.
     *
     * Idempotent by uri: the transcript is a recycling list, so the same
     * picture is mounted and unmounted repeatedly while scrolling and must
     * not re-fetch megabytes each time. A failure is remembered too — only an
     * explicit retry asks again.
     */
    fetchImage: (uri: string) => {
      if (requestedImages.current.has(uri)) return;
      requestedImages.current.add(uri);
      sendImageRequest(uri);
    },

    /** Forget a failed fetch and ask again, from the placeholder's tap. */
    retryImage: (uri: string) => {
      sendImageRequest(uri);
    },

    leave: () => {
      streamBoundary.current?.();
      restoring.current = undefined;
      sessionRef.current = undefined;
      viewingRef.current = undefined;
      // Leaving is a decision about the screen, so a reopen still in flight
      // no longer has a claim on it.
      awaitingResume.current = false;
      queued.current = undefined;
      // Same reasoning as `select`: nothing on screen refers to these bytes
      // any more, and a re-opened conversation re-requests what it can see.
      clearImages();
      setState((s) => ({
        ...s,
        sessionId: undefined,
        // Belongs to the conversation being closed, so it is dropped — and the
        // nonce is what makes the effect below actually ask again. Leaving
        // changes none of its other dependencies when the project is already
        // the chosen one, which is precisely the "new chat" case.
        workspace: undefined,
        // Belongs to the conversation being left: a context reading is about one
        // agent's window, and carrying it across would put the previous chat's
        // percentage beside this one's project.
        usage: undefined,
        workspaceNonce: s.workspaceNonce + 1,
        turns: [],
        configOptions: [],
        commands: [],
        busy: false,
        loadingSession: false,
        restoreTarget: undefined,
        restoreError: undefined,
        activity: IDLE_ACTIVITY,
        receipt: undefined,
      }));
    },
  };
}
