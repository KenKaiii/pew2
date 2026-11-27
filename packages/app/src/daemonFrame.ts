/**
 * Everything one sealed daemon frame does, from `secure.open(frame)` onward.
 *
 * The socket handler in `useDaemon.ts` deals with the cleartext frames (a
 * version mismatch, a refused device) and hands every `"e"` frame here. The
 * side effects that must not run inside an updater happen first; the state
 * transition itself is `reduceMessage` (`daemonReducer.ts`).
 */
import type { SecureChannel } from "@pew2/protocol";
import { matchesRestore, type RestoreTarget } from "./restoreState";
import { pendingSessionKey } from "./pendingSession";
import { remapSession } from "./outbox";
import { rememberConfigs } from "./configTruth";
import { isTimingTurn, IDLE_ACTIVITY } from "./activity";
import { advance, alreadySeen } from "./cursors";
import { isEmptyChunk, readChunk } from "./chunks";
import { toWireAttachments } from "./attachments";
import { offeredCommands } from "./slashCommands";
import {
  foldBackgroundCatchUp,
  foldBackgroundEvent,
  foldCatchUp,
  foldSessionEvents,
  type ReplayEvent,
} from "./replayFold";
import { receiptOnReplay } from "./turnReceipts";
import {
  applyGoalMessage,
  applyLiveEvent,
  applyQueue,
  applyReplayExtras,
  applyReviewMessage,
  applyTasksMessage,
} from "./ggState";
import type { StreamChunk } from "./streamBatch";
import type { ConfigOption, Workspace, WorkspaceEntry } from "./daemonTypes";
import { NOTICE_BUFFER, type TurnFinished } from "./daemonState";
import type { DaemonRefs } from "./daemonContext";
import { reduceMessage } from "./daemonReducer";

/** The one socket this frame arrived on, and its per-connection helpers. */
export interface FrameConnection {
  ws: WebSocket;
  secure: SecureChannel;
  resetStream: () => void;
  batch: { push(event: StreamChunk): void };
  flushOutbox: () => void;
}

/** The hook's refs and setters this handler reads and writes. */
export type FrameRefs = Pick<
  DaemonRefs,
  | "setState"
  | "setGg"
  | "setKnownConfigs"
  | "setKnownCommands"
  | "storeImage"
  | "restoring"
  | "streamForeground"
  | "sessionRef"
  | "viewingRef"
  | "providerRef"
  | "queued"
  | "outbox"
  | "pendingStart"
  | "awaitingResume"
  | "probed"
  | "pendingCapabilities"
  | "pendingProjectSessions"
  | "browseRequest"
  | "cursors"
  | "liveSessions"
  | "sessionsRef"
  | "providersRef"
  | "optionsRef"
  | "turnText"
  | "pushRegistered"
>;

export function handleSealedFrame(
  refs: FrameRefs,
  connection: FrameConnection,
  frame: unknown,
): void {
  const {
    setState,
    setGg,
    setKnownConfigs,
    setKnownCommands,
    storeImage,
    restoring,
    streamForeground,
    sessionRef,
    viewingRef,
    providerRef,
    queued,
    outbox,
    pendingStart,
    awaitingResume,
    probed,
    pendingCapabilities,
    pendingProjectSessions,
    browseRequest,
    cursors,
    liveSessions,
    sessionsRef,
    providersRef,
    optionsRef,
    turnText,
    pushRegistered,
  } = refs;
  const { ws, secure, resetStream, batch, flushOutbox } = connection;

  const message: any = secure.open(frame);
  // Undecryptable: a stray frame, a replay, or traffic from a pairing this
  // phone no longer holds the key for. Silently ignored — there is nothing
  // useful to show and nothing safe to act on.
  if (message === undefined) return;
  optionsRef.current.onFrame?.(message);

  // Only authenticated, visible prose may wait. Control/replay/background
  // frames flush before any notification or state transition below.
  const update = message.payload?.update;
  const batchable =
    streamForeground.current &&
    message.t === "session.event" &&
    message.sessionId === sessionRef.current &&
    (update?.sessionUpdate === "agent_message_chunk" ||
      update?.sessionUpdate === "agent_thought_chunk") &&
    update.content?.type === "text" &&
    typeof update.content.text === "string";
  if (!batchable) resetStream();

  // GG extension frames: state beside the transcript, never in it.
  if (message.t === "session.queue" && typeof message.sessionId === "string") {
    setGg((g) => applyQueue(g, message));
    return;
  }
  if (message.t === "goals" || message.t === "goal.result" || message.t === "goal.state") {
    setGg((g) => applyGoalMessage(g, message));
    return;
  }
  if (message.t === "plan.state" || message.t === "autopilot.state" || message.t === "checklist") {
    setGg((g) => applyReviewMessage(g, message));
    return;
  }
  if (message.t === "tasks") {
    setGg((g) => applyTasksMessage(g, message));
    return;
  }
  // A finished turn may have changed the project checklist or task list: an
  // open sheet re-asks. Not a filter on idle — it still falls through.
  if (message.t === "provider.capabilities" && message.extensions) {
    setGg((g) => applyReviewMessage(g, message));
  }
  if (message.t === "session.idle") {
    setGg((g) => ({
      ...g,
      checklistNonce: g.checklistNonce + 1,
      tasksNonce: g.tasksNonce + 1,
    }));
  }
  // Live state a replay restates (absent = an older daemon said nothing).
  // Only these fields: a logged `ask_user` in `events` is history and
  // must never open a card.
  if (message.t === "session.replay" && typeof message.sessionId === "string") {
    setGg((g) => applyReplayExtras(g, message));
  }
  // An older daemon that has never heard of `goals`: stop the spinner.
  if (message.t === "error" && message.code === "unknown_message") {
    setGg((g) => (g.goalsLoading ? { ...g, goalsLoading: false } : g));
  }

  // Replayed history, after a reconnect or a resume. Progressive batches
  // make long transcripts visible from the top while the agent continues
  // loading; each batch is still folded in one state update, avoiding the
  // quadratic event-by-event array copies that caused multi-second stalls.
  if (message.t === "session.replay" && Array.isArray(message.events)) {
    if (message.sessionId !== sessionRef.current) {
      // Another conversation's missed events, folded into the transcript
      // that conversation carries. Not rendered now — the user is reading
      // something else — but there to read when they open it, which is
      // the whole point of holding a transcript per session.
      //
      // Only for a catch-up. A *resume* replay of a background session
      // would be its full history arriving against turns this client
      // already has, and duplicating them is worse than waiting for the
      // reopen that asked for it.
      if (message.catchUp === true) {
        const missed: ReplayEvent[] = [];
        for (const event of message.events) {
          if (event?.t !== "session.event" || typeof event.seq !== "number") continue;
          // Same duplicate guard as the visible path below: a catch-up
          // and a live event can cross on the wire, and the cursor is
          // what stops the same chunk being appended twice.
          if (alreadySeen(cursors.current, event.sessionId, event.seq)) continue;
          cursors.current = advance(cursors.current, event.sessionId, event.seq);
          missed.push(event);
        }
        setState((prev) =>
          foldBackgroundCatchUp(
            prev,
            message.sessionId,
            missed,
            message.working === true,
            message.permissions,
          ),
        );
      }
      return;
    }
    const events: ReplayEvent[] = [];
    for (const event of message.events) {
      if (event?.t !== "session.event" || typeof event.seq !== "number") continue;
      if (alreadySeen(cursors.current, event.sessionId, event.seq)) continue;
      cursors.current = advance(cursors.current, event.sessionId, event.seq);
      events.push(event);
    }
    setState((prev) => {
      const folded = events.length > 0 ? foldSessionEvents(prev, events) : prev;

      // A reconnect catch-up is the opposite of history: these events are
      // a turn that is running right now, and the socket was simply not up
      // to carry them. See `foldCatchUp`.
      if (message.catchUp === true) {
        return foldCatchUp(
          prev,
          message.sessionId,
          events,
          message.working === true,
          Date.now(),
          // What the agent is still stopped on, which no replayed event
          // can say: a logged `permission_request` is skipped as history,
          // so without this the sheet the user dropped their signal in
          // front of never came back and the turn never resumed.
          message.permissions,
        );
      }

      const complete = message.complete !== false;
      // Reveal on the first real batch. An empty final frame still clears
      // the skeleton for sessions with no visible transcript.
      if (events.length === 0 && !complete) return folded;
      // Replay is history, not an active agent turn. Claude may still be
      // attaching in the background, but prompts safely queue server-side.
      //
      // Except when a turn is already running *here*. Every session gets a
      // replay the moment it goes live — empty, for one just created to
      // carry a first prompt — and clearing on that frame stopped the clock
      // before the agent had said anything. The turn then ended with no
      // start time to measure, so the first exchange of every conversation
      // finished without its "Answered in 4s" while every later one had it.
      //
      // "Running here" means a clock this device started, not `prev.busy`.
      // Opening an old conversation sets `busy` on the way in (it may still
      // be mid-turn on the desktop), and the replay is the only frame that
      // ever cleared it — so carrying it through here left every resumed
      // conversation pulsing in the drawer for as long as the app was open.
      const running = isTimingTurn(prev.activity);
      return {
        ...folded,
        loadingSession: folded.turns.length === 0 && message.more === true,
        busy: running,
        // Replayed tool calls finished long ago — the same reason a replay
        // batch never raises a permission. Timing them from this device's
        // clock would report a minutes-old turn as taking an instant. A
        // clock this device started is a different thing and is kept.
        activity: running ? prev.activity : IDLE_ACTIVITY,
        // The finished turn under the restored transcript, taken from the
        // conversation rather than from the screen: what is on screen may
        // still belong to the thread being left. Clearing it outright is
        // what made the line disappear on every reopen that goes through a
        // resume. See `receiptOnReplay`.
        receipt: receiptOnReplay(folded.sessions, message.sessionId, running),
        // The drawer entry too, and this is the flag the user actually
        // sees: the pulsing dot beside the conversation's name. Resuming
        // marks the session working on the way in, `session.started`
        // copies that onto its entry, and nothing else ever takes it off
        // for an agent that sends no `session.idle` after attaching.
        // Only this conversation — a background turn elsewhere is real.
        sessions: folded.sessions.map((session) =>
          session.id === message.sessionId && session.busy !== running
            ? { ...session, busy: running }
            : session,
        ),
      };
    });
    return;
  }

  // Advance the cursor here, as the message arrives, for the same reason
  // the session ref is tracked here: updaters must stay pure.
  if (message.t === "session.event" && typeof message.seq === "number") {
    // Replay and the live stream overlap, so an event received just
    // before the socket dropped can arrive again. Rendering it twice
    // would duplicate agent output on screen.
    if (alreadySeen(cursors.current, message.sessionId, message.seq)) return;
    cursors.current = advance(cursors.current, message.sessionId, message.seq);
    // A live question opens its card, on whichever session asked: it is
    // filed per session, so it waits there while another is on screen.
    setGg((g) => applyLiveEvent(g, message.sessionId, message.payload));
  }

  // Track the live session id here, as the message arrives, rather than
  // inside the updater below. Updaters must stay pure: React may invoke
  // them twice, and the ref would then desync from state.
  //
  // The awaited request id is read and cleared for the same reason, and
  // only when the daemon echoes the one this client sent: the daemon
  // broadcasts `session.started` to every paired client, so a session
  // opened on the laptop arrives here too and must not consume the row
  // this phone is holding for its own pending request.
  let adoptedRequestId: string | undefined;
  // Whether this conversation is the one on screen, or merely one the
  // daemon is announcing.
  //
  // `session.started` used to be taken as "this is now the screen",
  // unconditionally. It is broadcast to every paired client, so a session
  // opened anywhere — the laptop, another phone — redirected this one,
  // and because the frame carries no transcript the redirect arrived as a
  // blank conversation. Worse, it did that to a session the user had
  // deliberately opened moments earlier: send a prompt, switch away while
  // the agent boots, and the answer landed on whatever was being read,
  // emptying it. Recovering meant force-quitting, and the session that
  // caused it was the one nothing pointed at.
  //
  // So it takes the screen only when the screen is waiting for it: the
  // empty new-chat view, the row this client is holding for its own
  // request, or a reopen whose skeleton is already up.
  let claimsScreen = false;
  if (message.t === "session.started") {
    if (message.requestId && message.requestId === pendingStart.current) {
      adoptedRequestId = pendingStart.current;
      pendingStart.current = undefined;
    }
    const mine =
      adoptedRequestId !== undefined && viewingRef.current === pendingSessionKey(adoptedRequestId);
    const reopened =
      message.resumed === true &&
      awaitingResume.current &&
      matchesRestore(restoring.current, message);
    if (reopened) {
      awaitingResume.current = false;
      restoring.current = undefined;
    }
    claimsScreen =
      mine || reopened || (viewingRef.current === undefined && message.resumed !== true);
    if (claimsScreen) {
      sessionRef.current = message.sessionId;
      viewingRef.current = message.sessionId;
    }

    // The prompt this client is holding belongs to the session this
    // client started, not to whichever one the daemon announced next.
    // Delivering it to someone else's would put the user's message into a
    // conversation on another device — and lose it from this one.
    const pending = claimsScreen ? queued.current : undefined;
    if (pending) queued.current = undefined;
    if (pending) {
      ws.send(
        JSON.stringify(
          secure.seal(
            {
              t: "session.prompt",
              sessionId: message.sessionId,
              text: pending.text,
              attachments: toWireAttachments(pending.attachments),
            },
            { sid: message.sessionId },
          ),
        ),
      );
    }
  }

  // Keep what the agent is saying, per session, so a turn that ends off
  // screen can still be quoted in a notification. Above the scope filter
  // below on purpose: the sessions worth announcing are exactly the ones
  // not on screen, and under the filter their text would never be
  // collected.
  //
  // Written here rather than in a state updater, which React may run
  // twice — appending twice would duplicate the text.
  if (message.t === "session.event") {
    const chunk = readChunk(message.payload);
    if (chunk?.role === "agent" && chunk.text) {
      const seen = turnText.current.get(message.sessionId) ?? "";
      // Only the opening line is ever shown, so a long turn must not
      // accumulate megabytes per session for a 140-character banner.
      if (seen.length < NOTICE_BUFFER) turnText.current.set(message.sessionId, seen + chunk.text);
    }
  }

  // The daemon broadcasts every session to every client, and a previous
  // session can still be streaming after the user backs out and starts
  // another. Drop anything that is not the session on screen, otherwise
  // its output would appear in the wrong conversation.
  //
  // `session.idle` is deliberately absent: it is the only signal that a
  // conversation left running has finished, which is precisely the one
  // nobody is looking at. It is applied per session instead.
  const scoped = message.t === "session.event" || message.t === "session.config";
  if (scoped && message.sessionId !== sessionRef.current) {
    // Not on screen, but it is still someone's conversation. Its chunks go
    // into the transcript that session carries, so switching away from a
    // working agent and coming back shows the reply that landed while you
    // were gone rather than your own prompt and silence.
    //
    // `session.config` is genuinely not wanted here: it is answered by the
    // `session.config` case, which already mirrors it per session.
    if (message.t === "session.event") {
      setState((prev) =>
        foldBackgroundEvent(
          prev,
          message.sessionId,
          `${message.sessionId}:${message.seq}`,
          message.payload,
        ),
      );
    }
    return;
  }

  let completedTurn: TurnFinished | undefined;
  if (message.t === "session.idle") {
    const finished: string = message.sessionId;
    const lastText = turnText.current.get(finished);
    // One turn's worth: the next prompt in this session starts empty.
    turnText.current.delete(finished);
    const providerId =
      (message.providerId as string | undefined) ??
      sessionsRef.current.find((entry) => entry.id === finished)?.providerId;
    completedTurn = {
      sessionId: finished,
      folder: message.folder,
      agentName: providersRef.current.find((p) => p.id === providerId)?.name,
      lastText,
      activeSessionId: sessionRef.current,
      // How it ended, so the banner neither calls a crash "finished" nor
      // announces a turn someone stopped on purpose. Absent from an older
      // daemon, which only ever meant a normal finish.
      ...(message.outcome === "failed" || message.outcome === "cancelled"
        ? { outcome: message.outcome }
        : {}),
      ...(typeof message.reason === "string" ? { reason: message.reason } : {}),
    };

    // A turn just ended, so the agent may have written files: the
    // uncommitted count beside the composer is stale the instant it
    // finishes. Only the open session's project is on screen, so a
    // background session finishing must not re-ask for it. Opening a
    // session or switching agent is covered by the effect below, and
    // asking in both places would count the same repo twice.
    if (finished === sessionRef.current) {
      ws.send(
        JSON.stringify(
          secure.seal(
            {
              t: "workspace.status",
              sessionId: sessionRef.current,
              providerId: providerRef.current,
            },
            { sid: sessionRef.current },
          ),
        ),
      );
    }
  }

  // A session the daemon just opened is live by definition, so record it
  // before the announcement that would otherwise still call it stale.
  if (message.t === "session.started" && message.sessionId) {
    liveSessions.current = new Set(liveSessions.current ?? []).add(message.sessionId);

    // This conversation has a real id now, so the messages waiting on the
    // name it used to have are addressed to it and can go. Two names lead
    // here: the `pending:` key of the request this client sent, and the id
    // this conversation had under a daemon that has since restarted, which
    // a resume replaces. Re-addressed whether or not it is on screen — the
    // messages belong to the conversation, not to the screen.
    if (adoptedRequestId) {
      outbox.current = remapSession(
        outbox.current,
        pendingSessionKey(adoptedRequestId),
        message.sessionId,
      );
    }
    const resumed = message.agentSessionId
      ? sessionsRef.current.find(
          (entry) =>
            entry.agentSessionId === message.agentSessionId && entry.id !== message.sessionId,
        )
      : undefined;
    if (resumed) {
      outbox.current = remapSession(outbox.current, resumed.id, message.sessionId);
    }
    flushOutbox();
  }

  // What a *new* conversation with this agent will open with, held per
  // provider so the empty state can show it before any session exists.
  //
  // Only the two messages that actually describe that: the daemon's
  // capability reply, and its announcement that a provider-level choice
  // changed. Deliberately *not* fed from `session.started` or
  // `session.config` — those describe one conversation, and a resumed one
  // comes back at the selectors it was last held at rather than the ones
  // the next prompt would use. Folding them in here is what put "Opus" in
  // the pill and then ran the prompt on the remembered model instead.
  if (message.t === "provider.capabilities" || message.t === "provider.config") {
    const advertised: ConfigOption[] = message.configOptions ?? [];
    if (advertised.length > 0) {
      setKnownConfigs((known) =>
        rememberConfigs(known, message.providerId ?? providerRef.current, advertised),
      );
    }
  }

  // Slash commands, by contrast, are a property of the agent and the
  // project rather than of one conversation, so every message that carries
  // them is a fair source.
  if (
    message.t === "session.started" ||
    message.t === "session.config" ||
    message.t === "provider.capabilities"
  ) {
    // Learned from the probe session, so the sheet works in the empty
    // state — before a prompt has created a session to ask. Held per
    // provider, since every available agent is probed at startup and the
    // last reply to land must not become another agent's menu.
    const commands = offeredCommands(message.commands);
    const owner = message.providerId ?? providerRef.current;
    if (commands.length > 0 && owner) {
      setKnownCommands((known) => ({ ...known, [owner]: commands }));
    }
  }

  // Ask each available agent what it currently offers. The answer comes
  // from the agent, so an app that updates its model line-up is reflected
  // without changing anything here.
  if (message.t === "providers") {
    // Hand the daemon somewhere to push, once per connection.
    //
    // Here rather than beside `hello` because `hello` is cleartext and
    // this must be sealed: a push token identifies this phone, and the
    // relay is not entitled to it. `providers` is the daemon's first
    // sealed reply, so its arrival is the proof the channel is up.
    //
    // Re-sent on every reconnection, not cached, because tokens rotate;
    // the daemon keys them by device, so repeats replace rather than
    // accumulate. Failure is silent by design — a simulator, a fresh
    // clone with no EAS project, or a refused permission all land here,
    // and each one simply leaves the app with the local-only banners it
    // had before.
    const askPush = optionsRef.current.pushAddress;
    if (askPush && !pushRegistered.current) {
      pushRegistered.current = true;
      void askPush().then((address) => {
        // Reported as sent, not as accepted: the daemon stays silent on
        // success, and only speaks up to refuse. A refusal arrives as an
        // `error` below and puts this back to false.
        const sent = address !== undefined && ws.readyState === WebSocket.OPEN;
        if (sent) {
          ws.send(JSON.stringify(secure.seal({ t: "app.push", ...address })));
        }
        optionsRef.current.onPushRegistered?.(sent);
      });
    }
    if (Array.isArray(message.activeSessions)) {
      liveSessions.current = new Set<string>(message.activeSessions);
      // The conversation on screen may have died with a previous daemon
      // process. Reopen it from the agent's own copy rather than leaving
      // a thread that answers "Unknown session" on the next prompt.
      const current = sessionRef.current;
      const stale =
        current && !liveSessions.current.has(current)
          ? sessionsRef.current.find((entry) => entry.id === current)
          : !current && restoring.current?.id === viewingRef.current
            ? restoring.current
            : undefined;
      if (stale?.agentSessionId && stale.providerId) {
        const target: RestoreTarget = {
          id: stale.id,
          providerId: stale.providerId,
          agentSessionId: stale.agentSessionId,
          title: stale.title,
          cwd: stale.cwd,
        };
        restoring.current = target;
        sessionRef.current = undefined;
        // The screen is still this conversation, and the reopen about to
        // be sent is the one allowed to land on it.
        awaitingResume.current = true;
        providerRef.current = stale.providerId;
        ws.send(
          JSON.stringify(
            secure.seal({
              t: "session.resume",
              providerId: stale.providerId,
              agentSessionId: stale.agentSessionId,
              cwd: stale.cwd,
            }),
          ),
        );
        setState((s) => ({
          ...s,
          busy: true,
          loadingSession: true,
          restoreTarget: target,
          restoreError: undefined,
        }));
      }
    }
    for (const provider of message.providers ?? []) {
      if (!provider.available || probed.current.has(provider.id)) continue;
      probed.current.add(provider.id);
      pendingCapabilities.current.add(provider.id);
      ws.send(JSON.stringify(secure.seal({ t: "provider.capabilities", providerId: provider.id })));
    }

    // Anything typed while there was no signal goes now. Here rather than
    // in `onopen` for two reasons: this frame is the proof the sealed
    // channel works, and `activeSessions` above is what says whether the
    // conversation a queued prompt names still exists.
    flushOutbox();
  }
  if (message.t === "provider.capabilities") {
    pendingCapabilities.current.delete(message.providerId);
  }
  if (message.t === "provider.sessions") {
    pendingProjectSessions.current.delete(`${message.providerId}:${message.cwd}`);
  }
  // A daemon older than this app rejects `provider.sessions` outright, and
  // the rejection names no request. Dropping every in-flight key is the
  // safe read: the alternative is a set that never empties, so choosing
  // that project again would be ignored for the life of the socket.
  if (message.t === "error" && message.code === "unknown_message") {
    pendingProjectSessions.current.clear();
  }
  // A refused push token, for any of the three reasons it can be refused:
  // a daemon too old to know `app.push`, one that has not seen this
  // device's `hello`, or a token it will not accept. All three mean no
  // push will ever arrive, and the screen must go back to raising the
  // local banner — otherwise suppressing it in favour of a push that
  // cannot come leaves a backgrounded phone silent, which is worse than
  // the behaviour this feature replaced.
  if (
    message.t === "error" &&
    (message.code === "unknown_message" ||
      message.code === "push_unidentified" ||
      message.code === "push_token_invalid")
  ) {
    optionsRef.current.onPushRegistered?.(false);
  }

  // Project and git state, answered per request. An answer for a
  // conversation the user has already left describes the wrong project,
  // so it is dropped rather than shown for a second.
  if (message.t === "workspace" && typeof message.cwd === "string") {
    // Two ways an answer can describe the wrong project: it names a
    // conversation that is no longer on screen, or it is the
    // no-session answer (the agent's last project) arriving after a
    // session has since opened somewhere else.
    const mine = message.sessionId ? message.sessionId === sessionRef.current : !sessionRef.current;
    if (!mine) return;
    const workspace: Workspace = {
      cwd: message.cwd,
      folder: message.folder ?? message.cwd,
      repo: typeof message.repo === "boolean" ? message.repo : undefined,
      uncommitted:
        typeof message.uncommitted === "number" &&
        Number.isFinite(message.uncommitted) &&
        message.uncommitted >= 0
          ? message.uncommitted
          : undefined,
    };
    setState((s) => ({ ...s, workspace }));
    return;
  }

  // Browsing the desktop for a project. Answers are matched on
  // `requestId` so a slow listing for a directory the user has already
  // navigated away from cannot overwrite the one they are looking at —
  // which is otherwise easy to trigger by tapping down two levels fast.
  if (message.t === "workspaces" && typeof message.requestId === "string") {
    if (message.requestId !== browseRequest.current) return;
    const refused = message.refused === true;
    setState((s) => ({
      ...s,
      browse: {
        // A refusal names no directory, so the one already on screen is
        // kept. Taking the absent path would drop the pane back to the
        // suggestions view — losing the user's place as the reward for
        // tapping something that could not be opened.
        path: refused
          ? s.browse?.path
          : typeof message.path === "string"
            ? message.path
            : undefined,
        parent: refused
          ? s.browse?.parent
          : typeof message.parent === "string"
            ? message.parent
            : undefined,
        entries: refused
          ? (s.browse?.entries ?? [])
          : Array.isArray(message.entries)
            ? (message.entries as WorkspaceEntry[])
            : [],
        loading: false,
        refused,
      },
    }));
    return;
  }

  // Answered per request rather than as a session event, so it is handled
  // here and kept out of the transcript state entirely.
  if (message.t === "image" && typeof message.uri === "string") {
    const uri: string = message.uri;
    storeImage(
      uri,
      message.dataUri
        ? { status: "ready", dataUri: message.dataUri, mimeType: message.mimeType }
        : { status: "error", message: message.error ?? "Could not load this image" },
    );
    return;
  }

  if (
    message.t === "error" &&
    message.code === "resume_failed" &&
    message.sessionId &&
    message.sessionId !== sessionRef.current
  )
    return;

  // Read once, out here: an updater may run twice, and two different
  // clock readings would time the same turn differently on each pass.
  const now = Date.now();
  if (batchable) {
    const chunk = readChunk(message.payload);
    if (chunk && !isEmptyChunk(chunk)) {
      batch.push({
        sessionId: message.sessionId,
        id: `${message.sessionId}:${message.seq}`,
        chunk,
        payload: message.payload,
        now,
      });
    }
    return;
  }

  setState((prev) =>
    reduceMessage(prev, message, {
      sessionRef,
      pendingCapabilities,
      claimsScreen,
      adoptedRequestId,
      completedTurn,
      now,
    }),
  );
}
