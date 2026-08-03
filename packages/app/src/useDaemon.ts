/**
 * Daemon connection: one WebSocket, auto-reconnecting, translating the wire
 * envelope into rendered chat turns.
 *
 * ACP streams text as many small chunks, so consecutive agent chunks are
 * coalesced into a single message. Without this the list would grow by one row
 * per word and scrolling would fight the user.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { USE_FIXTURES, isFixtureSession, sampleSessions } from "./fixtures";
import { mergeAgentSessions, needsResume, replaceAgentSessionStub } from "./agentHistory";
import {
  beginActivity,
  foldActivity,
  summariseActivity,
  IDLE_ACTIVITY,
  type Activity,
  type TurnReceipt,
} from "./activity";
import { advance, alreadySeen, type Cursors } from "./cursors";
import { findDuplicateError } from "./errorDedup";
import { isEmptyChunk, readChunk } from "./chunks";
import type { ChatImage } from "./images";
import {
  attachmentImages,
  toWireAttachments,
  type PendingAttachment,
} from "./attachments";
import { defaultProviderId } from "./lastProvider";
import { loadLastProvider, saveLastProvider } from "./preferences";
import {
  offeredCommands,
  readAvailableCommands,
  type SlashCommand,
} from "./slashCommands";
import type { WireProject } from "./projects";
import { readUsage, type ContextUsage } from "./contextUsage";
import {
  foldSessionEvents,
  isOptimistic,
  mergeChunk,
  turnFromChunk,
  type ReplayEvent,
} from "./replayFold";

export type Status = "connecting" | "online" | "offline";

export interface Provider {
  id: string;
  name: string;
  description: string;
  available: boolean;
  unavailableReason?: string;
  color?: string;
}

/**
 * A desktop-local image being brought to the phone.
 *
 * `error` is a first-class state, not a silent failure: the whole point of this
 * path is that a missing picture explains itself instead of leaving a blank.
 */
export type ImageEntry =
  | { status: "loading" }
  | { status: "ready"; dataUri: string; mimeType?: string }
  | { status: "error"; message: string };

export interface PermissionRequest {
  requestId: string;
  title: string;
  options: { optionId: string; name: string }[];
}

export interface Turn {
  id: string;
  /**
   * Stable React identity, fixed for the life of the message.
   *
   * `id` is not that: an optimistic prompt adopts the server's id once the
   * daemon echoes it back, and the thread is a recycling list keyed by this,
   * so a changing key tears the cell down and re-parses its markdown — the
   * prompt visibly rendering a second time a moment after you sent it. Absent
   * on turns born with a server id, which never changes.
   */
  key?: string;
  role: "user" | "agent" | "thought" | "system";
  text: string;
  /**
   * Pictures the agent sent with this message, in order. Kept beside the text
   * rather than spliced into it: the bytes may be inline base64 (megabytes of
   * it) and markdown is re-parsed on every streamed chunk.
   */
  images?: ChatImage[];
}

/**
 * A session-level selector advertised by the connected agent: model, thinking
 * level, or mode. pew2 hardcodes no model names — each app reports its own.
 * https://agentclientprotocol.com/protocol/v1/session-config-options
 */
export interface ConfigOption {
  id: string;
  name: string;
  category?: string;
  type: string;
  currentValue: string | boolean;
  options?: { value: string; name: string; description?: string }[];
}

/** A past conversation, grouped by the agent that ran it. */
export interface Session {
  id: string;
  providerId: string;
  /** First user message, used as the list title. */
  title: string;
  startedAt: number;
  turns: Turn[];
  /** Message rows available before this transcript is opened. */
  messageCount?: number;
  /** The selectors this session was running with, restored when reopened. */
  configOptions: ConfigOption[];
  /**
   * The agent's own id for this conversation, when it came from the agent's
   * history rather than this app. Present means it has not been opened yet:
   * its turns live on the agent's disk and arrive on resume.
   */
  agentSessionId?: string;
  /** Working directory the agent recorded, needed to reopen it there. */
  cwd?: string;
  /**
   * Project name for the drawer, as the daemon stamped it on a finished turn.
   * Only the desktop can resolve it, and a session this app started has no
   * `cwd` of its own to derive it from.
   */
  folder?: string;
  /**
   * The agent is mid-turn in this conversation, whether or not it is on
   * screen.
   *
   * Per session rather than the single `busy` flag because the daemon keeps
   * every session running while the phone looks at one of them: leaving a
   * conversation does not stop its agent, so the drawer has to be able to say
   * which ones are still working.
   */
  busy?: boolean;
  /**
   * A turn finished here while the user was somewhere else. Cleared when the
   * conversation is opened, so the drawer marks what is worth going back to.
   */
  unread?: boolean;
}



/**
 * The project the open session is working in, as the daemon sees it.
 *
 * Only the desktop can answer this, and it goes stale the moment the agent
 * edits a file, so it is re-asked rather than remembered across sessions.
 */
export interface Workspace {
  cwd: string;
  folder: string;
  repo: boolean;
  uncommitted: number;
}

interface State {
  status: Status;
  providers: Provider[];
  sessionId?: string;
  /** The agent the composer will talk to. Chosen before a session exists. */
  activeProviderId?: string;
  turns: Turn[];
  /** Every conversation this client has seen, newest first. */
  sessions: Session[];
  /** Selectors for the open session, in the agent's own priority order. */
  configOptions: ConfigOption[];
  /**
   * Slash commands the agent offers, minus the ones this app hides. Depends on
   * the project it opened, so it is per session rather than per provider.
   */
  commands: SlashCommand[];
  permission?: PermissionRequest;
  busy: boolean;
  /**
   * Tool calls in the open session's current turn, folded live.
   *
   * Only the open session: this drives one line under the transcript, and a
   * background agent's tools are not what the reader is watching. It resets
   * with every prompt, so it is never a log — it is the present tense.
   */
  activity: Activity;
  /**
   * What the last turn did, shown once it is over and cleared when the next
   * one starts. Absent for a turn this client did not time itself.
   */
  receipt?: TurnReceipt;
  /**
   * At least one agent has been asked what it holds and has not answered yet.
   * The drawer shows skeleton rows instead of a false "No conversations yet".
   */
  loadingSessions: boolean;
  /** A stored transcript is loading and is not ready to reveal yet. */
  loadingSession: boolean;
  /** Project and git state for the session on screen. Absent until asked. */
  workspace?: Workspace;
  /**
   * How full the agent's context window is, for the session on screen.
   *
   * Absent until the agent volunteers one, and it stays absent for agents that
   * never do (GG Coder sends none today) — which is why the row omits the
   * reading entirely rather than showing a confident 0%.
   */
  usage?: ContextUsage;
  /**
   * Bumped whenever the answer is stale for a reason the request itself cannot
   * see.
   *
   * The workspace request is driven by session, provider and chosen project, so
   * it re-asks when one of those changes. Leaving a conversation changes none of
   * them: from the empty screen, with a project already picked, "new chat"
   * clears the workspace and every dependency stays equal — so nothing re-asked
   * and the project row simply vanished until a prompt created a session. This
   * is the explicit "ask again" the effect otherwise has no way to hear.
   */
  workspaceNonce: number;
  /**
   * Every project each agent has worked in, keyed by provider id.
   *
   * Folded by the daemon from the agent's whole history, not from `sessions`:
   * that list is capped at the newest conversations and so describes a week's
   * work rather than the set of projects a user can return to.
   */
  projects: Record<string, WireProject[]>;
  /**
   * The project the drawer is narrowed to, per agent. Absent means all of
   * them, which is where every agent starts.
   *
   * Per agent rather than one global choice: the projects belong to an agent,
   * so switching apps and back must not carry a path the new agent has never
   * opened — and must not silently forget the one you just picked either.
   */
  projectPath: Record<string, string>;
  /**
   * `providerId:cwd` of the project whose conversations are being fetched.
   *
   * In state rather than a ref because it decides between the skeleton and
   * "No conversations in pew2 yet" — a ref would be read during a render
   * nothing schedules, so the false empty state would show until the reply
   * landed, which is the flash this exists to prevent.
   */
  loadingProject?: string;
}

/**
 * Last-known selectors per provider.
 *
 * A session only reports its options once it exists, but the model selector has
 * to be usable on an empty screen — choosing a model is part of composing the
 * first prompt. Remembering the last set an agent advertised lets the picker
 * appear immediately, and the live session overwrites it as soon as it opens.
 */
function rememberConfigs(
  known: Record<string, ConfigOption[]>,
  providerId: string | undefined,
  options: ConfigOption[],
): Record<string, ConfigOption[]> {
  if (!providerId || options.length === 0) return known;
  return { ...known, [providerId]: options };
}

/**
 * A user turn rendered before the daemon has echoed it back. Its id is replaced
 * with the server's once the echo arrives, so it never renders twice.
 */
function localTurn(seq: number, text: string, images?: ChatImage[]): Turn {
  // `key` outlives the id swap in the echo path, so the cell rendering this
  // prompt survives reconciliation instead of remounting.
  return {
    id: `local:${seq}`,
    key: `local:${seq}`,
    role: "user",
    text: text.trim(),
    // Rendered from the phone's own copy, so an attached photo appears the
    // instant it is sent rather than after a round trip to fetch back the file
    // this device just uploaded.
    ...(images?.length ? { images } : {}),
  };
}

/**
 * Marks a first prompt that was stopped while its agent was still starting, so
 * it never reached the daemon. Carries a `local:` id like the prompt above it:
 * `session.started` keeps only locally-created turns, and this one belongs with
 * the message it explains.
 */
function stoppedBeforeSend(seq: number): Turn {
  return {
    id: `local:${seq}`,
    key: `local:${seq}`,
    role: "system",
    text: "Stopped before the agent received this.",
  };
}

function firstUserText(turns: Turn[]): string | undefined {
  const first = turns.find((turn) => turn.role === "user");
  return first?.text.trim().slice(0, 60);
}



/**
 * A turn that just ended, reported to the app so it can announce it.
 *
 * The hook reports rather than decides: whether this is worth a banner depends
 * on whether the app is on screen, which only the component tree knows. See
 * `notificationPolicy.ts`.
 */
export interface TurnFinished {
  sessionId: string;
  /** Project folder as the daemon stamped it, e.g. "pew2". */
  folder?: string;
  /** Display name of the agent that ran it. */
  agentName?: string;
  /** What the agent said this turn, for the notification body. */
  lastText?: string;
  /** The conversation on screen when this landed, if any. */
  activeSessionId?: string;
}

/**
 * How much of an agent's turn is kept for a notification body.
 *
 * Only the first usable line is ever rendered, so this only has to be long
 * enough to contain it past any leading blank lines or a fenced block.
 */
const NOTICE_BUFFER = 2000;

interface DaemonOptions {
  /** Called once per finished turn, for any session — not just the open one. */
  onTurnFinished?: (turn: TurnFinished) => void;
}

/**
 * @param deviceId Identifies this phone to the relay, which uses it to tell
 * devices apart. Falls back to a constant so a direct LAN connection, where the
 * daemon does not care, still works.
 */
export function useDaemon(url: string, deviceId = "phone", options: DaemonOptions = {}) {
  const [state, setState] = useState<State>({
    status: "connecting",
    providers: [],
    turns: [],
    // Sample conversations in development so history and long-response
    // rendering can be reviewed with content. Real sessions are appended
    // ahead of these and never replaced by them.
    sessions: USE_FIXTURES ? sampleSessions() : [],
    configOptions: [],
    commands: [],
    busy: false,
    activity: IDLE_ACTIVITY,
    loadingSessions: false,
    loadingSession: false,
    projects: {},
    projectPath: {},
    workspaceNonce: 0,
  });

  // Not in State: this is a cache keyed by provider, not part of the session.
  //
  // Never seeded from fixtures. These selectors drive the live top bar, so a
  // sample "Model: Sonnet" would be presented as this agent's real capability
  // and then be silently replaced by the truth once a session opened. Only an
  // agent's own advertisement may populate this.
  const [knownConfigs, setKnownConfigs] = useState<Record<string, ConfigOption[]>>({});
  // Pictures the daemon has been asked to read off the desktop's disk, keyed by
  // the path the agent named. Outside State because it is a cache belonging to
  // this device's viewport, not to the conversation: it is never replayed,
  // never mirrored into history, and a resumed thread re-requests what it can
  // actually see. Inline `data:` sources never enter here at all.
  const [images, setImages] = useState<Record<string, ImageEntry>>({});
  // Commands per provider, kept outside the session so opening a conversation
  // does not blank the menu for agents that never send the ACP notification and
  // are served from their project's files instead.
  const [knownCommands, setKnownCommands] = useState<Record<string, SlashCommand[]>>({});

  const socket = useRef<WebSocket | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);
  const alive = useRef(true);
  // Mirrors state.sessionId so actions can read it without doing work inside a
  // state updater. Updaters must stay pure: React may invoke them twice.
  const sessionRef = useRef<string | undefined>(undefined);
  // Mirrors activeProviderId for the same reason sessionRef exists: message
  // handlers must not read state inside an updater.
  const providerRef = useRef<string | undefined>(undefined);
  // The chosen project per provider, mirrored out of state for the same reason
  // `providerRef` exists: `start` must read the choice made moments ago, not
  // the one captured when its callback was memoized.
  const projectRef = useRef<Record<string, string>>({});
  // The message entered before a session existed — text and any files with it.
  // Sent as soon as the daemon confirms one, so the composer works straight
  // from the empty state.
  const queued = useRef<
    { text: string; attachments: readonly PendingAttachment[] } | undefined
  >(undefined);
  // Counter behind the ids of optimistic user turns. Starting an agent can take
  // seconds, and the daemon's echo arrives only after that, so the prompt is
  // rendered locally first and reconciled when the echo lands.
  const localSeq = useRef(0);
  // Providers already asked for capabilities, so a reconnect's repeat provider
  // announcement does not spawn another probe for each one.
  const probed = useRef(new Set<string>());
  // Capability requests in flight, keyed by provider. One slow or broken agent
  // must not keep another provider's already-loaded history behind a skeleton.
  const pendingCapabilities = useRef(new Set<string>());
  // Per-project session requests in flight, keyed by `providerId:cwd`, so
  // choosing a project shows the loading skeleton rather than the empty state
  // it is about to replace.
  const pendingProjectSessions = useRef(new Set<string>());
  // Highest `seq` seen per session.
  //
  // This is what makes reconnecting gap-free. ACP does not replay messages
  // emitted while a client was away, so the relay stores them and hands back
  // everything after the cursor. On a phone this is not an edge case: the
  // socket dies every time the app is backgrounded or the network changes, and
  // without a cursor the tail of every interrupted turn is lost for good.
  const cursors = useRef<Cursors>({});
  // Images already asked for. A ref, not the state map: the request has to be
  // deduped at the moment of asking, which happens outside any updater.
  const requestedImages = useRef(new Set<string>());
  // Daemon session ids the daemon says it currently holds.
  //
  // Session ids belong to a daemon *process*, but this list survives restarts
  // and reconnects, so a conversation on screen can name an id that no longer
  // exists — prompting it answered "Unknown session". The daemon reports its
  // open sessions with every provider announcement, and `hello` triggers one,
  // so a stale entry is reopened by `agentSessionId` instead.
  //
  // Undefined means the daemon never said (an older build): assume every id is
  // live rather than resuming conversations that were fine.
  const liveSessions = useRef<Set<string> | undefined>(undefined);
  // Mirrors state.sessions so openSession can look one up without doing that
  // work inside a state updater.
  const sessionsRef = useRef<Session[]>(state.sessions);
  // Synced in an effect rather than during render: writing a ref while
  // rendering is the same impurity the updaters above avoid.
  useEffect(() => {
    sessionsRef.current = state.sessions;
  }, [state.sessions]);

  // Agents by id, so a finished turn can be announced by name without reading
  // state inside the socket handler.
  const providersRef = useRef<Provider[]>(state.providers);
  useEffect(() => {
    providersRef.current = state.providers;
  }, [state.providers]);

  // Held in a ref so a changing handler never re-opens the socket.
  const onTurnFinished = useRef(options.onTurnFinished);
  useEffect(() => {
    onTurnFinished.current = options.onTurnFinished;
  }, [options.onTurnFinished]);

  // What each session's agent has said during its current turn, keyed by
  // session, so a notification can quote a conversation that is not on screen.
  //
  // A ref, not state: this is a buffer for one message, it must not re-render
  // anything, and it is written from the socket handler where an updater's
  // "may run twice" rule would corrupt an accumulation.
  const turnText = useRef(new Map<string, string>());

  // The agent this device used last, read once from storage.
  //
  // Closing the app is not a decision to go back to whichever agent sorts
  // first, so a launch re-targets the last one used. Undefined means "not read
  // yet": the keychain read starts at mount and finishes long before the
  // daemon's provider list arrives over the socket, so no chip is shown for the
  // wrong agent first.
  const [rememberedProviderId, setRememberedProviderId] = useState<string | undefined>(
    undefined,
  );
  useEffect(() => {
    let cancelled = false;
    loadLastProvider().then((id) => {
      if (!cancelled && id) setRememberedProviderId(id);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Where the composer points before the user picks anything this launch.
  const fallbackProviderId = defaultProviderId(state.providers, rememberedProviderId);

  // Remember every agent the user lands on — chosen from the drawer, opened
  // from history, or started by the daemon — so the next launch resumes there.
  useEffect(() => {
    if (state.activeProviderId) void saveLastProvider(state.activeProviderId);
  }, [state.activeProviderId]);

  // The agent the composer targets, including the implicit first-available one
  // the user never explicitly chose. `providerRef` only knows about deliberate
  // selections, so on a fresh launch it is empty while the UI already names an
  // agent — and a model picked right then would have nowhere to go. Kept in an
  // effect below for the same reason as `sessionsRef`.
  const targetProviderRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    targetProviderRef.current = state.activeProviderId ?? fallbackProviderId;
  }, [state.activeProviderId, fallbackProviderId]);

  useEffect(() => {
    alive.current = true;

    const connect = () => {
      if (!alive.current) return;
      setState((s) => ({ ...s, status: "connecting" }));

      const ws = new WebSocket(url);
      socket.current = ws;

      ws.onopen = () => {
        attempts.current = 0;
        // A request written to the socket that died is never answered, and its
        // entry would hold the drawer in a skeleton forever. Dropping them here
        // also lets the open project be asked for again.
        pendingProjectSessions.current.clear();
        setState((s) => ({
          ...s,
          status: "online",
          // Turns end while the phone is asleep and the socket is dead, and
          // `session.idle` is not replayed — only `session.event` is persisted.
          // So anything believed to be working across a drop is a guess, and
          // the pulsing dot would never stop. Clear it: a session still running
          // announces itself the moment it finishes, which is the signal that
          // matters.
          sessions: s.sessions.map((session) =>
            session.busy ? { ...session, busy: false } : session,
          ),
        }));
        ws.send(
          JSON.stringify({
            t: "hello",
            wire: 1,
            role: "app",
            deviceId,
            // "Everything after this, please." Empty on a first connection.
            cursors: cursors.current,
          }),
        );
      };

      ws.onmessage = (event) => {
        let message: any;
        try {
          message = JSON.parse(event.data as string);
        } catch {
          return;
        }

        // Replayed history, after a reconnect or a resume. Progressive batches
        // make long transcripts visible from the top while the agent continues
        // loading; each batch is still folded in one state update, avoiding the
        // quadratic event-by-event array copies that caused multi-second stalls.
        if (message.t === "session.replay" && Array.isArray(message.events)) {
          if (message.sessionId !== sessionRef.current) return;
          const events: ReplayEvent[] = [];
          for (const event of message.events) {
            if (event?.t !== "session.event" || typeof event.seq !== "number") continue;
            if (alreadySeen(cursors.current, event.sessionId, event.seq)) continue;
            cursors.current = advance(cursors.current, event.sessionId, event.seq);
            events.push(event);
          }
          setState((prev) => {
            const folded = events.length > 0 ? foldSessionEvents(prev, events) : prev;
            const complete = message.complete !== false;
            // Reveal on the first real batch. An empty final frame still clears
            // the skeleton for sessions with no visible transcript.
            if (events.length === 0 && !complete) return folded;
            return {
              ...folded,
              loadingSession: false,
              // Replay is history, not an active agent turn. Claude may still be
              // attaching in the background, but prompts safely queue server-side.
              busy: false,
              // Replayed tool calls finished long ago — the same reason a replay
              // batch never raises a permission. Timing them from this device's
              // clock would report a minutes-old turn as taking an instant.
              activity: IDLE_ACTIVITY,
              receipt: undefined,
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
        }

        // Track the live session id here, as the message arrives, rather than
        // inside the updater below. Updaters must stay pure: React may invoke
        // them twice, and the ref would then desync from state.
        if (message.t === "session.started") {
          sessionRef.current = message.sessionId;

          const pending = queued.current;
          queued.current = undefined;
          if (pending) {
            ws.send(
              JSON.stringify({
                t: "session.prompt",
                sessionId: message.sessionId,
                text: pending.text,
                attachments: toWireAttachments(pending.attachments),
              }),
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
            if (seen.length < NOTICE_BUFFER)
              turnText.current.set(message.sessionId, seen + chunk.text);
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
        if (scoped && message.sessionId !== sessionRef.current) return;

        if (message.t === "session.idle") {
          const finished: string = message.sessionId;
          const lastText = turnText.current.get(finished);
          // One turn's worth: the next prompt in this session starts empty.
          turnText.current.delete(finished);
          const providerId =
            (message.providerId as string | undefined) ??
            sessionsRef.current.find((entry) => entry.id === finished)?.providerId;
          onTurnFinished.current?.({
            sessionId: finished,
            folder: message.folder,
            agentName: providersRef.current.find((p) => p.id === providerId)?.name,
            lastText,
            activeSessionId: sessionRef.current,
          });

          // A turn just ended, so the agent may have written files: the
          // uncommitted count beside the composer is stale the instant it
          // finishes. Only the open session's project is on screen, so a
          // background session finishing must not re-ask for it. Opening a
          // session or switching agent is covered by the effect below, and
          // asking in both places would count the same repo twice.
          if (finished === sessionRef.current) {
            ws.send(
              JSON.stringify({
                t: "workspace.status",
                sessionId: sessionRef.current,
                providerId: providerRef.current,
              }),
            );
          }
        }

        // A session the daemon just opened is live by definition, so record it
        // before the announcement that would otherwise still call it stale.
        if (message.t === "session.started" && message.sessionId) {
          liveSessions.current = new Set(liveSessions.current ?? []).add(message.sessionId);
        }

        // Cache selectors against the provider so they survive the session and
        // are available before the next one starts. `provider.capabilities` is
        // the same data probed ahead of a session, so the empty state can offer
        // a real model list rather than nothing.
        if (
          message.t === "session.started" ||
          message.t === "session.config" ||
          message.t === "provider.capabilities"
        ) {
          const advertised: ConfigOption[] = message.configOptions ?? [];
          if (advertised.length > 0) {
            setKnownConfigs((known) =>
              rememberConfigs(known, message.providerId ?? providerRef.current, advertised),
            );
          }
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
          if (Array.isArray(message.activeSessions)) {
            liveSessions.current = new Set<string>(message.activeSessions);
            // The conversation on screen may have died with a previous daemon
            // process. Reopen it from the agent's own copy rather than leaving
            // a thread that answers "Unknown session" on the next prompt.
            const current = sessionRef.current;
            const stale =
              current && !liveSessions.current.has(current)
                ? sessionsRef.current.find((entry) => entry.id === current)
                : undefined;
            if (stale?.agentSessionId && stale.providerId) {
              sessionRef.current = undefined;
              providerRef.current = stale.providerId;
              ws.send(
                JSON.stringify({
                  t: "session.resume",
                  providerId: stale.providerId,
                  agentSessionId: stale.agentSessionId,
                  cwd: stale.cwd,
                }),
              );
              setState((s) => ({ ...s, busy: true, loadingSession: true }));
            }
          }
          for (const provider of message.providers ?? []) {
            if (!provider.available || probed.current.has(provider.id)) continue;
            probed.current.add(provider.id);
            pendingCapabilities.current.add(provider.id);
            ws.send(
              JSON.stringify({ t: "provider.capabilities", providerId: provider.id }),
            );
          }
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

        // Project and git state, answered per request. An answer for a
        // conversation the user has already left describes the wrong project,
        // so it is dropped rather than shown for a second.
        if (message.t === "workspace" && typeof message.cwd === "string") {
          // Two ways an answer can describe the wrong project: it names a
          // conversation that is no longer on screen, or it is the
          // no-session answer (the agent's last project) arriving after a
          // session has since opened somewhere else.
          const mine = message.sessionId
            ? message.sessionId === sessionRef.current
            : !sessionRef.current;
          if (!mine) return;
          const workspace: Workspace = {
            cwd: message.cwd,
            folder: message.folder ?? message.cwd,
            repo: message.repo === true,
            uncommitted: message.uncommitted ?? 0,
          };
          setState((s) => ({ ...s, workspace }));
          return;
        }

        // Answered per request rather than as a session event, so it is handled
        // here and kept out of the transcript state entirely.
        if (message.t === "image" && typeof message.uri === "string") {
          const uri: string = message.uri;
          setImages((known) => ({
            ...known,
            [uri]: message.dataUri
              ? { status: "ready", dataUri: message.dataUri, mimeType: message.mimeType }
              : { status: "error", message: message.error ?? "Could not load this image" },
          }));
          return;
        }

        // Read once, out here: an updater may run twice, and two different
        // clock readings would time the same turn differently on each pass.
        const now = Date.now();

        setState((prev) => {
          switch (message.t) {
            case "providers":
              return {
                ...prev,
                providers: message.providers ?? [],
                loadingSessions: pendingCapabilities.current.size > 0,
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
              const local = prev.turns.filter(isOptimistic);
              const turns = local.length === prev.turns.length ? prev.turns : local;
              return {
                ...prev,
                sessionId: message.sessionId,
                activeProviderId: message.providerId ?? prev.activeProviderId,
                configOptions: message.configOptions ?? [],
                // Keep any prompt already rendered optimistically: it belongs to
                // this session, which was started to deliver it.
                turns,
                sessions: replaceAgentSessionStub(prev.sessions, {
                  id: message.sessionId,
                  providerId: message.providerId ?? prev.activeProviderId ?? "",
                  title:
                    firstUserText(turns) ?? resumedFrom?.title ?? "New conversation",
                  startedAt: Date.now(),
                  turns,
                  configOptions: message.configOptions ?? [],
                  agentSessionId,
                  // A session started to deliver a first prompt is already
                  // working; the drawer must say so from the moment it exists.
                  busy: prev.busy,
                }),
                // Keep the skeleton until the batched transcript follows this frame.
                loadingSession: message.resumed === true,
                busy: message.resumed === true,
              };
            }

            case "session.idle": {
              // Arrives for every session, including ones this client is not
              // showing, so the flags are set per session and only the open
              // one touches the global spinner. Without that, a background
              // agent finishing would stop the spinner on the turn you are
              // actually watching.
              const mine = message.sessionId === prev.sessionId;
              return {
                ...prev,
                busy: mine ? false : prev.busy,
                // The live line exits here, and what it was doing becomes the
                // receipt. Only for the session on screen: a background turn's
                // tools were never rendered and have nothing to summarise.
                activity: mine ? IDLE_ACTIVITY : prev.activity,
                receipt: mine ? summariseActivity(prev.activity, now) : prev.receipt,
                sessions: prev.sessions.map((session) =>
                  session.id === message.sessionId
                    ? {
                        ...session,
                        busy: false,
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
                  session.id === message.sessionId
                    ? { ...session, configOptions }
                    : session,
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
                if (message.sessionId !== sessionRef.current) return base;
                return { ...base, usage };
              }

              if (payload?.kind === "permission_request") {
                const params = payload.params ?? {};
                return {
                  ...base,
                  busy: false,
                  permission: {
                    requestId: payload.requestId,
                    title: params.toolCall?.title ?? "The agent needs your approval",
                    options: params.options ?? [
                      { optionId: "allow", name: "Allow" },
                      { optionId: "reject", name: "Reject" },
                    ],
                  },
                };
              }

              const chunk = readChunk(payload);
              if (!chunk || isEmptyChunk(chunk)) return base;

              const turns = [...prev.turns];
              const last = turns[turns.length - 1];
              // The echo of a prompt this client already rendered: adopt the
              // server id in place rather than showing the message twice. Text
              // is the only handle on that identity, so an image-only chunk is
              // never mistaken for an echo of one.
              const optimistic =
                chunk.role === "user" && chunk.text
                  ? turns.findIndex(
                      (turn) => isOptimistic(turn) && turn.text === chunk.text,
                    )
                  : -1;
              if (optimistic >= 0) {
                turns[optimistic] = {
                  ...turns[optimistic]!,
                  id: `${message.sessionId}:${message.seq}`,
                };
              } else if (last && last.role === chunk.role && chunk.role !== "user") {
                // Coalesce consecutive chunks of the same role into one bubble.
                turns[turns.length - 1] = mergeChunk(last, chunk);
              } else {
                // `seq` restarts at 0 for every session, so it alone would
                // collide across sessions and produce duplicate React keys.
                turns.push(turnFromChunk(`${message.sessionId}:${message.seq}`, chunk));
              }
              // Mirror into history so the sidebar can reopen this later, and
              // title the session from its first user message.
              const sessions = prev.sessions.map((session) =>
                session.id === message.sessionId
                  ? {
                      ...session,
                      turns,
                      title:
                        session.title === "New conversation" && chunk.role === "user"
                          ? chunk.text.trim().slice(0, 60)
                          : session.title,
                    }
                  : session,
              );

              return { ...base, turns, sessions, busy: chunk.role !== "system" };
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
                return prev.loadingProject === undefined
                  ? prev
                  : { ...prev, loadingProject: undefined };
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
                turns: [
                  ...prev.turns,
                  // Date.now() collides when two errors land in the same
                  // millisecond; the length keeps it unique within the thread.
                  {
                    id: `err-${prev.turns.length}-${Date.now()}`,
                    role: "system",
                    text: message.message,
                  },
                ],
              };
            }

            default:
              return prev;
          }
        });
      };

      const scheduleReconnect = () => {
        // Only the current socket may drive reconnection. On Fast Refresh or a
        // url change, the previous socket's onclose fires after the new one is
        // already open; without this guard it would mark us offline and open a
        // duplicate connection that keeps dispatching state updates.
        if (!alive.current || socket.current !== ws) return;
        setState((s) => ({ ...s, status: "offline" }));
        // Exponential backoff, capped, so a sleeping laptop does not get hammered.
        const delay = Math.min(1000 * 2 ** attempts.current, 10_000);
        attempts.current += 1;
        retry.current = setTimeout(connect, delay);
      };

      ws.onclose = scheduleReconnect;
      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      alive.current = false;
      if (retry.current) clearTimeout(retry.current);
      const ws = socket.current;
      socket.current = null;
      // Drop the handlers before closing so the outgoing socket cannot mutate
      // state or schedule a reconnect after teardown.
      if (ws) {
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
      }
    };
  }, [url]);

  /** Returns false when nothing was sent, so a caller can report the failure. */
  const post = useCallback((message: unknown) => {
    const ws = socket.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    ws.send(JSON.stringify(message));
    return true;
  }, []);

  // Sent outside any state updater: React may invoke an updater twice, and a
  // socket write in one would ask the daemon for the same picture twice.
  const sendImageRequest = useCallback(
    (uri: string) => {
      const sent = post({
        t: "image.fetch",
        requestId: uri,
        sessionId: sessionRef.current,
        uri,
      });
      setImages((known) => ({
        ...known,
        [uri]: sent
          ? { status: "loading" }
          : // Offline: say so rather than spinning forever on a request that was
            // never written to a socket.
            { status: "error", message: "Not connected to your computer" },
      }));
    },
    [post],
  );

  const actions = useMemo(
    () => ({
      /**
       * `initialText` and its attachments are sent automatically once the
       * session is ready.
       */
      start: (
        providerId: string,
        initialText?: string,
        attachments: readonly PendingAttachment[] = [],
      ) => {
        const started = Date.now();
        queued.current = initialText ? { text: initialText, attachments } : undefined;
        // A chosen project is where this conversation opens. Without it the
        // daemon falls back to the agent's last workspace, which is the whole
        // reason picking a project from the phone was impossible before.
        post({ t: "session.start", providerId, cwd: projectRef.current[providerId] });
        if (!initialText) return;
        // Spawning the agent and its ACP handshake take seconds; without a local
        // turn the screen would sit empty and look like the send did nothing.
        const turn = localTurn(localSeq.current++, initialText, attachmentImages(attachments));
        setState((s) => ({
          ...s,
          busy: true,
          loadingSession: false,
          turns: [...s.turns, turn],
          // The clock starts when the prompt leaves the phone, not when the
          // agent first speaks: booting the agent is part of the wait.
          activity: beginActivity(started),
          receipt: undefined,
        }));
        // The session itself does not exist yet, so there is nothing to mark
        // busy: `session.started` creates its drawer entry, already working.
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
      prompt: (text: string, to?: string, attachments: readonly PendingAttachment[] = []): boolean => {
        const sessionId = to ?? sessionRef.current;
        if (!sessionId) return false;
        if (to && to !== sessionRef.current) {
          const target = sessionsRef.current.find((entry) => entry.id === to);
          if (!target || needsResume(target, liveSessions.current)) return false;
        }
        post({ t: "session.prompt", sessionId, text, attachments: toWireAttachments(attachments) });
        const started = Date.now();
        const turn = localTurn(localSeq.current++, text, attachmentImages(attachments));
        const visible = sessionId === sessionRef.current;
        setState((s) => {
          const turns = visible ? [...s.turns, turn] : s.turns;
          return {
            ...s,
            busy: visible ? true : s.busy,
            // A prompt sent to another conversation is not what this transcript
            // is showing, so the line under it keeps describing this one.
            activity: visible ? beginActivity(started) : s.activity,
            receipt: visible ? undefined : s.receipt,
            turns,
            sessions: s.sessions.map((session) =>
              session.id === sessionId
                ? {
                    ...session,
                    turns: [...session.turns, turn],
                    // Marked working here, not on the first streamed chunk:
                    // an agent can think for a long time before it says
                    // anything, and the drawer should show that as work.
                    busy: true,
                    unread: false,
                    title:
                      session.title === "New conversation"
                        ? turn.text.slice(0, 60)
                        : session.title,
                  }
                : session,
            ),
          };
        });
        return true;
      },

      cancel: () => {
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

      answer: (requestId: string, optionId: string) => {
        const sessionId = sessionRef.current;
        if (sessionId) post({ t: "session.permission", sessionId, requestId, optionId });
        setState((s) => ({ ...s, permission: undefined, busy: true }));
      },

      /** Change a model, thinking level or mode on the open session. */
      setConfig: (configId: string, value: string | boolean) => {
        const sessionId = sessionRef.current;
        if (sessionId) {
          post({ t: "session.config", sessionId, configId, value });
          return;
        }

        // Nothing to set it on yet: a conversation is only created by its first
        // prompt, so before then the daemon holds the choice against the
        // provider and the new session opens with it applied. Without this the
        // pill in the empty state silently did nothing until you had sent a
        // message — the one moment you are most likely to be choosing a model.
        const providerId = providerRef.current ?? targetProviderRef.current;
        if (!providerId) return;
        post({ t: "provider.config", providerId, configId, value });
        // Reflected locally: with no session there is no `session.config` echo
        // coming back, and the pill has to show what was picked.
        setKnownConfigs((known) => ({
          ...known,
          [providerId]: (known[providerId] ?? []).map((option) =>
            option.id === configId ? { ...option, currentValue: value } : option,
          ),
        }));
      },

      /** Reopen a past conversation from the sidebar. */
      openSession: (sessionId: string) => {
        const session = sessionsRef.current.find((entry) => entry.id === sessionId);
        if (!session) return;

        // A conversation from the agent's own history has no turns here yet:
        // they live on the agent's disk and stream back as ordinary events once
        // it loads. Show the agent and wait rather than rendering it empty.
        //
        // A session this app started is shown from memory instead — unless the
        // daemon no longer holds it. See `needsResume`.
        if (needsResume(session, liveSessions.current)) {
          sessionRef.current = undefined;
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
            busy: true,
            loadingSession: true,
            // Both describe the conversation being left.
            activity: IDLE_ACTIVITY,
            receipt: undefined,
            sessions: s.sessions.map((entry) =>
              entry.id === sessionId ? { ...entry, unread: false } : entry,
            ),
          }));
          return;
        }

        // Fixture transcripts exist only on this device, so they must never
        // become the target of a prompt, cancel or config change: the daemon
        // has never heard of them and those messages would vanish silently.
        // Opening one shows its history and selects its agent; typing then
        // starts a real session instead of posting against a phantom id.
        const live = !isFixtureSession(sessionId);
        sessionRef.current = live ? sessionId : undefined;
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
          // Belongs to the conversation being left: a context reading is about one
          // agent's window, and carrying it across would put the previous chat's
          // percentage beside this one's project.
          usage: undefined,
          workspaceNonce: s.workspaceNonce + 1,
          turns: session.turns,
          configOptions: session.configOptions,
          // This conversation's own state, not a reset: it may still be
          // mid-turn on the desktop, and clearing the spinner here would show
          // a running agent as finished.
          busy: session.busy === true,
          loadingSession: false,
          // A conversation still running elsewhere has tools this client never
          // saw, and a finished one's receipt belongs to the thread it was
          // measured in. Either way this opens without one.
          activity: IDLE_ACTIVITY,
          receipt: undefined,
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
            : Object.fromEntries(
                Object.entries(s.projectPath).filter(([id]) => id !== providerId),
              ),
          // Any fetch still in flight is for the project just left, so its
          // skeleton no longer describes this list. Back to "all projects"
          // especially: nothing is being fetched at all, and leaving this set
          // would hold the drawer in a skeleton over history it already has.
          loadingProject: undefined,
        }));
        // The request itself is an effect below, so a project chosen while
        // offline is still asked for the moment the socket comes back.
      },

      /** Choose which agent the composer targets. Ends any open session. */
      select: (providerId: string) => {
        sessionRef.current = undefined;
        providerRef.current = providerId;
        queued.current = undefined;
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
        sessionRef.current = undefined;
        queued.current = undefined;
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
          activity: IDLE_ACTIVITY,
          receipt: undefined,
        }));
      },
    }),
    [post, sendImageRequest],
  );

  // Which project the bar above the composer names.
  //
  // Driven by the session and agent on screen rather than by a one-off request:
  // opening a past conversation, switching agents or reconnecting all change
  // the answer, and each of those is exactly a change to these values. Live
  // edits are covered by the `session.idle` refresh in the socket handler, and
  // the cases that clear the row without changing any of these carry the nonce.
  const workspaceProviderId = state.activeProviderId ?? fallbackProviderId;
  useEffect(() => {
    if (state.status !== "online") return;
    post({
      t: "workspace.status",
      sessionId: state.sessionId,
      providerId: workspaceProviderId,
      // Before a session exists this is what the context row describes: the
      // project the next prompt will open in, rather than whichever one the
      // agent happened to use last.
      cwd: workspaceProviderId ? state.projectPath[workspaceProviderId] : undefined,
    });
  }, [
    post,
    state.status,
    state.sessionId,
    workspaceProviderId,
    workspaceProviderId ? state.projectPath[workspaceProviderId] : undefined,
    // Leaving a conversation changes none of the above when the project is
    // already the chosen one, and the row would stay empty until a prompt.
    state.workspaceNonce,
  ]);

  // Fall back to the last selectors this agent advertised, so the model picker
  // is available on an empty screen instead of only mid-conversation.
  //
  // The provider defaults the same way the UI does: before an explicit choice
  // this launch, the composer already targets the remembered agent, so the
  // selector has to describe that same agent rather than nothing.
  const effectiveProviderId = state.activeProviderId ?? fallbackProviderId;
  const configOptions =
    state.configOptions.length > 0
      ? state.configOptions
      : (effectiveProviderId ? knownConfigs[effectiveProviderId] : undefined) ?? [];
  // The live session's own list wins; otherwise the provider's, which is what
  // agents that never send the notification rely on entirely.
  const commands =
    state.commands.length > 0
      ? state.commands
      : (effectiveProviderId ? knownCommands[effectiveProviderId] : undefined) ?? [];
  const loadingSessions = effectiveProviderId
    ? pendingCapabilities.current.has(effectiveProviderId) ||
      state.loadingProject !== undefined
    : false;

  // Fetch the chosen project's conversations.
  //
  // An effect rather than part of `selectProject` so the one rule covers a
  // reconnect too: the socket dies on every backgrounding, and a request
  // written to the dead one is never answered.
  const openProjectPath = effectiveProviderId
    ? state.projectPath[effectiveProviderId]
    : undefined;
  useEffect(() => {
    if (state.status !== "online" || !effectiveProviderId || !openProjectPath) return;
    const key = `${effectiveProviderId}:${openProjectPath}`;
    if (pendingProjectSessions.current.has(key)) return;
    pendingProjectSessions.current.add(key);
    const sent = post({
      t: "provider.sessions",
      providerId: effectiveProviderId,
      cwd: openProjectPath,
    });
    if (!sent) {
      pendingProjectSessions.current.delete(key);
      return;
    }
    setState((s) => ({ ...s, loadingProject: key }));
  }, [post, state.status, effectiveProviderId, openProjectPath]);

  return {
    ...state,
    ...actions,
    // Exported so the UI names the same agent the composer targets: the drawer
    // and top bar must not show Claude Code while a prompt would go elsewhere.
    effectiveProviderId,
    configOptions,
    commands,
    loadingSessions,
    images,
  };
}
