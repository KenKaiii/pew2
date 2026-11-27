/**
 * The state transition for one decrypted daemon frame, once the socket handler
 * (`daemonFrame.ts`) has done everything that must happen outside an updater.
 * Runs inside `setState`, so it stays pure: React may invoke it twice.
 */
import type { RefObject } from "react";
import { mergeAgentSessions, replaceAgentSessionStub } from "./agentHistory";
import { recordReceipt } from "./turnReceipts";
import { adoptPendingSession } from "./pendingSession";
import { foldActivity, summariseActivity, IDLE_ACTIVITY } from "./activity";
import { findDuplicateError } from "./errorDedup";
import { isEmptyChunk, readChunk } from "./chunks";
import { readAvailableCommands } from "./slashCommands";
import { readUsage } from "./contextUsage";
import { applyChunk, capTurns, isOptimistic } from "./replayFold";
import { readPlanAcceptedSession } from "./ggReview";
import { readPermissionRequest } from "./permissions";
import type { Session } from "./daemonTypes";
import { firstUserText, type State, type TurnFinished } from "./daemonState";

/** What the handler worked out before the update, read by the transition. */
export interface MessageScope {
  sessionRef: RefObject<string | undefined>;
  pendingCapabilities: RefObject<Set<string>>;
  claimsScreen: boolean;
  adoptedRequestId: string | undefined;
  completedTurn: TurnFinished | undefined;
  now: number;
}

// `message` is `any` exactly as it was in useDaemon.ts: a decrypted frame.
export function reduceMessage(prev: State, message: any, scope: MessageScope): State {
  const { sessionRef, pendingCapabilities, claimsScreen, adoptedRequestId, completedTurn, now } =
    scope;
  switch (message.t) {
    case "providers":
      return {
        ...prev,
        machineName: message.machine?.name || prev.machineName,
        providers: message.providers ?? [],
        // Absent means "nothing to report" *or* "a daemon too old to
        // have the field", and both have to clear the notice — a
        // banner the daemon can no longer take back would outlive the
        // update it describes.
        update: message.update,
        loadingSessions: pendingCapabilities.current.size > 0,
        // No agent to wait on (none available, or all asked already).
        heard: prev.heard || pendingCapabilities.current.size === 0,
      };

    case "provider.capabilities": {
      // Fold in the conversations the agent already holds on disk, so
      // the drawer shows work started at the desk too.
      const sessions = mergeAgentSessions(
        prev.sessions,
        message.providerId,
        message.sessions,
        message.canResume === true,
      );
      // Always publish the provider's completion. Even an empty response
      // must clear its own skeleton while unrelated probes continue.
      return {
        ...prev,
        sessions,
        projects: message.providerId
          ? { ...prev.projects, [message.providerId]: message.projects ?? [] }
          : prev.projects,
        loadingSessions: pendingCapabilities.current.size > 0,
        heard: prev.heard || pendingCapabilities.current.size === 0,
      };
    }

    case "provider.sessions": {
      // One project's conversations, asked for when it was chosen. The
      // capped history in `provider.capabilities` is the newest work
      // across every project, so a project touched before that window
      // has nothing in the list until this lands.
      return {
        ...prev,
        sessions: mergeAgentSessions(
          prev.sessions,
          message.providerId,
          message.sessions,
          message.canResume === true,
        ),
        // Cleared only by the answer it was set for: a reply for a
        // project the user has already moved on from must not end the
        // skeleton over the one they are waiting on.
        loadingProject:
          prev.loadingProject === `${message.providerId}:${message.cwd}`
            ? undefined
            : prev.loadingProject,
      };
    }

    case "session.started": {
      // A resumed conversation arrives with the agent's id for it. Its
      // drawer entry is a stub whose turns live on the agent's disk, so
      // this live session *replaces* it — prepending both would list
      // the same conversation twice.
      const agentSessionId = message.agentSessionId as string | undefined;
      const resumedFrom = agentSessionId
        ? prev.sessions.find((s) => s.agentSessionId === agentSessionId)
        : undefined;
      // Same array when nothing is dropped, which is the common case: a
      // fresh identity re-renders the whole transcript for no change,
      // seen as the first prompt flickering the instant the session
      // opens — right after it was sent.
      //
      // Only the transcript on screen is a candidate: a conversation
      // announced while the user is reading a different one has no
      // optimistic turns of its own, and taking them from the visible
      // thread would move that thread's unsent prompt into it.
      const visibleTurns = claimsScreen ? prev.turns : [];
      const local = visibleTurns.filter(isOptimistic);
      const turns = local.length === visibleTurns.length ? visibleTurns : local;
      const live: Session = {
        id: message.sessionId,
        providerId: message.providerId ?? prev.activeProviderId ?? "",
        title: firstUserText(turns) ?? resumedFrom?.title ?? "New conversation",
        startedAt: Date.now(),
        turns,
        configOptions: message.configOptions ?? [],
        agentSessionId,
        // The project this conversation belongs to, known now rather
        // than at the end of its first turn. `session.idle` used to be
        // the only thing that ever set this, and the drawer filters by
        // it — so with a project selected a new conversation was absent
        // from the list until it had finished replying, which is the
        // one moment the user is most likely to go looking for it.
        //
        // The daemon's answer only, never this phone's selected project
        // as a fallback. This frame is broadcast, so most of the time it
        // describes a conversation started somewhere else, and guessing
        // would file another device's work under whatever project this
        // screen happens to be showing. A session that arrives without
        // one is left unplaced, and `session.idle` still names it later.
        cwd: message.cwd ?? resumedFrom?.cwd,
        // A session started to deliver a first prompt is already
        // working; the drawer must say so from the moment it exists.
        // Only when this is that session: `prev.busy` describes the
        // conversation on screen, and copying it onto an unrelated one
        // announced from another device is a row that pulses for work
        // it is not doing.
        busy: claimsScreen ? prev.busy : undefined,
      };
      // The row this client already added when it asked, if this is the
      // answer to that request. Adopting it in place keeps the
      // conversation where the user last saw it in the list instead of
      // removing a row and prepending a near-identical one.
      const adopted = adoptPendingSession(prev.sessions, adoptedRequestId, live);
      const sessions = adopted ?? replaceAgentSessionStub(prev.sessions, live);
      // In the drawer either way — that is the whole point of this
      // frame — but the screen is only redirected when it was waiting
      // for this conversation. See `claimsScreen`.
      if (!claimsScreen) return { ...prev, sessions };
      return {
        ...prev,
        sessions,
        sessionId: message.sessionId,
        activeProviderId: message.providerId ?? prev.activeProviderId,
        configOptions: message.configOptions ?? [],
        // Keep any prompt already rendered optimistically: it belongs to
        // this session, which was started to deliver it.
        turns,
        // Keep the skeleton until the batched transcript follows this frame.
        loadingSession: message.resumed === true,
        // `prev.busy`, not `false`, for a session started to carry a
        // first prompt: `start` already marked it working and began the
        // clock. Overwriting that stopped the timer before the agent had
        // said anything, so `summariseActivity` found no start time and
        // the first turn of every conversation finished without its
        // "Answered in 4s" — every later turn had one.
        busy: message.resumed === true ? true : prev.busy,
      };
    }

    case "session.idle": {
      // Arrives for every session, including ones this client is not
      // showing, so the flags are set per session and only the open
      // one touches the global spinner. Without that, a background
      // agent finishing would stop the spinner on the turn you are
      // actually watching.
      const mine = message.sessionId === prev.sessionId;
      // What the turn did, summarised once. Only the visible session
      // has an `activity` to summarise — a background turn's tools were
      // never rendered — so this is undefined for the others, which is
      // also the honest answer: nothing was measured.
      const receipt = mine ? summariseActivity(prev.activity, now) : undefined;
      return {
        ...prev,
        // A bounded transient notification queue, not transcript state.
        completedTurns: completedTurn
          ? [...(prev.completedTurns ?? []), completedTurn].slice(-128)
          : prev.completedTurns,
        busy: mine ? false : prev.busy,
        // A turn cannot end while its agent is waiting to be let past a
        // tool, so an approval still standing here died with the turn:
        // cancelled, or the agent gave up. The daemon has already
        // forgotten it, and a button that posts an id nothing is
        // listening for is worse than no button.
        permission: mine ? undefined : prev.permission,
        // The live line exits here, and what it was doing becomes the
        // receipt.
        activity: mine ? IDLE_ACTIVITY : prev.activity,
        receipt: mine ? receipt : prev.receipt,
        // Stored on the conversation too, so reopening it shows the
        // same line rather than losing it to navigation.
        sessions: recordReceipt(prev.sessions, message.sessionId, receipt).map((session) =>
          session.id === message.sessionId
            ? {
                ...session,
                busy: false,
                permission: undefined,
                // Worth going back to, and marked as such until it is
                // opened. Never for the conversation on screen: its
                // reply is already there to read.
                unread: !mine,
                folder: session.folder ?? message.folder,
              }
            : session,
        ),
      };
    }

    case "session.config": {
      const configOptions = message.configOptions ?? [];
      return {
        ...prev,
        configOptions,
        // Mirror into history so reopening restores the same selection.
        sessions: prev.sessions.map((session) =>
          session.id === message.sessionId ? { ...session, configOptions } : session,
        ),
      };
    }

    case "session.event": {
      const payload = message.payload;

      // Folded before anything else, and carried through every exit
      // below: a tool call is not a chunk, so most of this case returns
      // early and would otherwise drop the very updates it is watching.
      const activity = foldActivity(prev.activity, payload, now);
      // Same object when the event changed no tool, so a streamed word
      // of prose does not re-render the footer.
      const base = activity === prev.activity ? prev : { ...prev, activity };

      // Sent once per session rather than per turn, and specific to the
      // project the agent opened, so it is held until replaced.
      const commands = readAvailableCommands(payload);
      if (commands) return { ...base, commands };

      // How full the agent's context window is. Held like `commands` —
      // it describes the session, not this turn — and filtered to the
      // session on screen, since the daemon broadcasts every session's
      // events and another project's meter is not this one's.
      const usage = readUsage(payload);
      if (usage) {
        // Kept on the conversation's row whether or not it's on screen,
        // so reopening it shows the reading straight away.
        const sessions = base.sessions.map((row) =>
          row.id === message.sessionId ? { ...row, usage } : row,
        );
        if (message.sessionId !== sessionRef.current) return { ...base, sessions };
        return { ...base, usage, sessions };
      }

      const permission = readPermissionRequest(payload);
      if (permission) {
        return {
          ...base,
          busy: false,
          permission,
          // Filed against the conversation as well as shown, so it is
          // still answerable after switching away — and so a reconnect,
          // which restates every open request, has something to
          // reconcile against.
          sessions: base.sessions.map((session) =>
            session.id === message.sessionId ? { ...session, permission } : session,
          ),
        };
      }

      const chunk = readChunk(payload);
      if (!chunk || isEmptyChunk(chunk)) return base;

      const turns = [...prev.turns];
      // Shared with the replay fold and with background sessions, so a
      // conversation reads the same whether it was watched live, caught
      // up after a drop, or written while the user was elsewhere.
      applyChunk(turns, `${message.sessionId}:${message.seq}`, chunk);
      // Bounded here rather than inside that helper: this is the one
      // place a turn is added to the visible transcript, and it runs for
      // every chunk of every streamed answer.
      const capped = capTurns(turns);
      // An accepted plan keeps its transcript but moves to the implementation's session.
      const moved = readPlanAcceptedSession(payload);
      // Mirror into history so the sidebar can reopen this later, and
      // title the session from its first user message.
      const sessions = prev.sessions.map((session) =>
        session.id === message.sessionId
          ? {
              ...session,
              turns: capped,
              title:
                session.title === "New conversation" && chunk.role === "user"
                  ? chunk.text.trim().slice(0, 60)
                  : session.title,
              ...(moved ? { agentSessionId: moved } : {}),
            }
          : session,
      );

      return {
        ...base,
        turns: capped,
        sessions,
        busy: chunk.role === "ken" || chunk.role === "note" ? base.busy : chunk.role !== "system",
      };
    }

    case "error": {
      // A desktop older than this app does not know an optional request
      // (the workspace bar's, first of all). That is not a failure of
      // anything the user did: rendering it would drop a system turn
      // into the transcript and clear `busy` mid-stream, killing the
      // spinner on a turn that is still running. The bar simply stays
      // empty until that daemon is updated.
      //
      // One thing must still be undone: a `provider.sessions` this
      // daemon cannot answer would otherwise leave the drawer on its
      // skeleton forever — an endless spinner over the project whose
      // conversations are the one thing an old daemon cannot list.
      // Falling back to the history already held is the honest state.
      if (message.code === "unknown_message") {
        return prev.loadingProject === undefined ? prev : { ...prev, loadingProject: undefined };
      }

      if (prev.restoreTarget && (prev.loadingSession || message.code === "resume_failed")) {
        return { ...prev, busy: false, loadingSession: false, restoreError: message.message };
      }

      // Agents usually stream a failure as message text and then reject
      // the turn, so the same sentence arrives twice. Promote the copy
      // already on screen instead of appending a second one: the user
      // sees it once, and in the colour that says it failed.
      const duplicate = findDuplicateError(prev.turns, message.message);
      if (duplicate >= 0) {
        const turns = [...prev.turns];
        // Keep the agent's own wording, which may carry more context
        // than the rejection; only its severity was wrong.
        turns[duplicate] = { ...turns[duplicate]!, role: "system" };
        return { ...prev, busy: false, loadingSession: false, turns };
      }
      return {
        ...prev,
        busy: false,
        loadingSession: false,
        turns: capTurns([
          ...prev.turns,
          // Date.now() collides when two errors land in the same
          // millisecond; the length keeps it unique within the thread.
          {
            id: `err-${prev.turns.length}-${Date.now()}`,
            role: "system",
            text: message.message,
          },
        ]),
      };
    }

    default:
      return prev;
  }
}
