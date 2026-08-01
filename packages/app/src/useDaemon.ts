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
import { mergeAgentSessions, replaceAgentSessionStub } from "./agentHistory";
import { advance, alreadySeen, type Cursors } from "./cursors";
import { findDuplicateError } from "./errorDedup";
import { isEmptyChunk, readChunk } from "./chunks";
import type { ChatImage } from "./images";
import {
  offeredCommands,
  readAvailableCommands,
  type SlashCommand,
} from "./slashCommands";
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
   * At least one agent has been asked what it holds and has not answered yet.
   * The drawer shows skeleton rows instead of a false "No conversations yet".
   */
  loadingSessions: boolean;
  /** A stored transcript is loading and is not ready to reveal yet. */
  loadingSession: boolean;
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
function localTurn(seq: number, text: string): Turn {
  // `key` outlives the id swap in the echo path, so the cell rendering this
  // prompt survives reconciliation instead of remounting.
  return {
    id: `local:${seq}`,
    key: `local:${seq}`,
    role: "user",
    text: text.trim(),
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
 * @param deviceId Identifies this phone to the relay, which uses it to tell
 * devices apart. Falls back to a constant so a direct LAN connection, where the
 * daemon does not care, still works.
 */
export function useDaemon(url: string, deviceId = "phone") {
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
    loadingSessions: false,
    loadingSession: false,
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
  // Text entered before a session existed. Sent as soon as the daemon confirms
  // one, so the composer works straight from the empty state.
  const queued = useRef<string | undefined>(undefined);
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
  // Mirrors state.sessions so openSession can look one up without doing that
  // work inside a state updater.
  const sessionsRef = useRef<Session[]>(state.sessions);
  // Synced in an effect rather than during render: writing a ref while
  // rendering is the same impurity the updaters above avoid.
  useEffect(() => {
    sessionsRef.current = state.sessions;
  }, [state.sessions]);

  // The agent the composer targets, including the implicit first-available one
  // the user never explicitly chose. `providerRef` only knows about deliberate
  // selections, so on a fresh launch it is empty while the UI already names an
  // agent — and a model picked right then would have nowhere to go. Kept in an
  // effect below for the same reason as `sessionsRef`.
  const targetProviderRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    targetProviderRef.current =
      state.activeProviderId ?? state.providers.find((p) => p.available)?.id;
  }, [state.activeProviderId, state.providers]);

  useEffect(() => {
    alive.current = true;

    const connect = () => {
      if (!alive.current) return;
      setState((s) => ({ ...s, status: "connecting" }));

      const ws = new WebSocket(url);
      socket.current = ws;

      ws.onopen = () => {
        attempts.current = 0;
        setState((s) => ({ ...s, status: "online" }));
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
                text: pending,
              }),
            );
          }
        }

        // The daemon broadcasts every session to every client, and a previous
        // session can still be streaming after the user backs out and starts
        // another. Drop anything that is not the session on screen, otherwise
        // its output would appear in the wrong conversation.
        const scoped =
          message.t === "session.event" ||
          message.t === "session.idle" ||
          message.t === "session.config";
        if (scoped && message.sessionId !== sessionRef.current) return;

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
                loadingSessions: pendingCapabilities.current.size > 0,
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
                }),
                // Keep the skeleton until the batched transcript follows this frame.
                loadingSession: message.resumed === true,
                busy: message.resumed === true,
              };
            }

            case "session.idle":
              // The turn finished. Without this the spinner would never stop.
              return { ...prev, busy: false };

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

              // Sent once per session rather than per turn, and specific to the
              // project the agent opened, so it is held until replaced.
              const commands = readAvailableCommands(payload);
              if (commands) return { ...prev, commands };

              if (payload?.kind === "permission_request") {
                const params = payload.params ?? {};
                return {
                  ...prev,
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
              if (!chunk || isEmptyChunk(chunk)) return prev;

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

              return { ...prev, turns, sessions, busy: chunk.role !== "system" };
            }

            case "error": {
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
      /** `initialText` is sent automatically once the session is ready. */
      start: (providerId: string, initialText?: string) => {
        queued.current = initialText;
        post({ t: "session.start", providerId });
        if (!initialText) return;
        // Spawning the agent and its ACP handshake take seconds; without a local
        // turn the screen would sit empty and look like the send did nothing.
        const turn = localTurn(localSeq.current++, initialText);
        setState((s) => ({
          ...s,
          busy: true,
          loadingSession: false,
          turns: [...s.turns, turn],
        }));
      },

      prompt: (text: string) => {
        const sessionId = sessionRef.current;
        if (!sessionId) return;
        post({ t: "session.prompt", sessionId, text });
        const turn = localTurn(localSeq.current++, text);
        setState((s) => {
          const turns = [...s.turns, turn];
          return {
            ...s,
            busy: true,
            turns,
            sessions: s.sessions.map((session) =>
              session.id === sessionId
                ? {
                    ...session,
                    turns,
                    title:
                      session.title === "New conversation"
                        ? turn.text.slice(0, 60)
                        : session.title,
                  }
                : session,
            ),
          };
        });
      },

      cancel: () => {
        const sessionId = sessionRef.current;
        if (sessionId) {
          post({ t: "session.cancel", sessionId });
          setState((s) => ({ ...s, busy: false }));
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
        if (session.agentSessionId) {
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
            turns: [],
            configOptions: [],
            // Cleared so the previous conversation's menu is not offered for
            // this one; the provider's own list below fills it back in.
            commands: [],
            busy: true,
            loadingSession: true,
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
          turns: session.turns,
          configOptions: session.configOptions,
          busy: false,
          loadingSession: false,
        }));
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
          turns: [],
          // Selectors belong to the old agent's session; keeping them would
          // show another agent's model name in the top bar. Its slash commands
          // are wrong here for the same reason.
          configOptions: [],
          commands: [],
          busy: false,
          loadingSession: false,
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
          turns: [],
          configOptions: [],
          commands: [],
          busy: false,
          loadingSession: false,
        }));
      },
    }),
    [post, sendImageRequest],
  );

  // Fall back to the last selectors this agent advertised, so the model picker
  // is available on an empty screen instead of only mid-conversation.
  //
  // The provider defaults the same way the UI does: before an explicit choice,
  // the composer already targets the first available agent, so the selector has
  // to describe that same agent rather than nothing.
  const effectiveProviderId =
    state.activeProviderId ?? state.providers.find((p) => p.available)?.id;
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
    ? pendingCapabilities.current.has(effectiveProviderId)
    : false;

  return { ...state, ...actions, configOptions, commands, loadingSessions, images };
}
