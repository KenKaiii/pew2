/**
 * Daemon connection: one WebSocket, auto-reconnecting, translating the wire
 * envelope into rendered chat turns.
 *
 * ACP streams text as many small chunks, so consecutive agent chunks are
 * coalesced into a single message. Without this the list would grow by one row
 * per word and scrolling would fight the user.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export type Status = "connecting" | "online" | "offline";

export interface Provider {
  id: string;
  name: string;
  description: string;
  available: boolean;
  unavailableReason?: string;
  color?: string;
}

export interface PermissionRequest {
  requestId: string;
  title: string;
  options: { optionId: string; name: string }[];
}

export interface Turn {
  id: string;
  role: "user" | "agent" | "thought" | "system";
  text: string;
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
  permission?: PermissionRequest;
  busy: boolean;
}

/** Pull display text out of an ACP `session/update` payload. */
function readChunk(payload: any): { role: Turn["role"]; text: string } | undefined {
  const update = payload?.update;
  if (update?.sessionUpdate === "agent_message_chunk") {
    return { role: "agent", text: update.content?.text ?? "" };
  }
  if (update?.sessionUpdate === "agent_thought_chunk") {
    return { role: "thought", text: update.content?.text ?? "" };
  }
  if (payload?.kind === "user_message") {
    return { role: "user", text: payload.text ?? "" };
  }
  if (payload?.kind === "exit") {
    return { role: "system", text: `Agent exited (code ${payload.code ?? "?"})` };
  }
  return undefined;
}

export function useDaemon(url: string) {
  const [state, setState] = useState<State>({
    status: "connecting",
    providers: [],
    turns: [],
    sessions: [],
    configOptions: [],
    busy: false,
  });

  const socket = useRef<WebSocket | null>(null);
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null);
  const attempts = useRef(0);
  const alive = useRef(true);
  // Mirrors state.sessionId so actions can read it without doing work inside a
  // state updater. Updaters must stay pure: React may invoke them twice.
  const sessionRef = useRef<string | undefined>(undefined);
  // Text entered before a session existed. Sent as soon as the daemon confirms
  // one, so the composer works straight from the empty state.
  const queued = useRef<string | undefined>(undefined);

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
        ws.send(JSON.stringify({ t: "hello", wire: 1, role: "app", deviceId: "sim", cursors: {} }));
      };

      ws.onmessage = (event) => {
        let message: any;
        try {
          message = JSON.parse(event.data as string);
        } catch {
          return;
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

        setState((prev) => {
          switch (message.t) {
            case "providers":
              return { ...prev, providers: message.providers ?? [] };

            case "session.started":
              return {
                ...prev,
                sessionId: message.sessionId,
                activeProviderId: message.providerId ?? prev.activeProviderId,
                configOptions: message.configOptions ?? [],
                turns: [],
                sessions: [
                  {
                    id: message.sessionId,
                    providerId: message.providerId ?? prev.activeProviderId ?? "",
                    title: "New conversation",
                    startedAt: Date.now(),
                    turns: [],
                  },
                  ...prev.sessions,
                ],
                busy: false,
              };

            case "session.idle":
              // The turn finished. Without this the spinner would never stop.
              return { ...prev, busy: false };

            case "session.config":
              return { ...prev, configOptions: message.configOptions ?? [] };

            case "session.event": {
              const payload = message.payload;

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
              if (!chunk || !chunk.text) return prev;

              const turns = [...prev.turns];
              const last = turns[turns.length - 1];
              // Coalesce consecutive chunks of the same role into one bubble.
              if (last && last.role === chunk.role && chunk.role !== "user") {
                turns[turns.length - 1] = { ...last, text: last.text + chunk.text };
              } else {
                // `seq` restarts at 0 for every session, so it alone would
                // collide across sessions and produce duplicate React keys.
                turns.push({
                  id: `${message.sessionId}:${message.seq}`,
                  role: chunk.role,
                  text: chunk.text,
                });
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

            case "error":
              return {
                ...prev,
                busy: false,
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

  const post = useCallback((message: unknown) => {
    const ws = socket.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }, []);

  const actions = useMemo(
    () => ({
      /** `initialText` is sent automatically once the session is ready. */
      start: (providerId: string, initialText?: string) => {
        queued.current = initialText;
        post({ t: "session.start", providerId });
        if (initialText) setState((s) => ({ ...s, busy: true }));
      },

      prompt: (text: string) => {
        const sessionId = sessionRef.current;
        if (!sessionId) return;
        post({ t: "session.prompt", sessionId, text });
        setState((s) => ({ ...s, busy: true }));
      },

      cancel: () => {
        const sessionId = sessionRef.current;
        if (sessionId) post({ t: "session.cancel", sessionId });
        setState((s) => ({ ...s, busy: false }));
      },

      answer: (requestId: string, optionId: string) => {
        const sessionId = sessionRef.current;
        if (sessionId) post({ t: "session.permission", sessionId, requestId, optionId });
        setState((s) => ({ ...s, permission: undefined, busy: true }));
      },

      /** Change a model, thinking level or mode on the open session. */
      setConfig: (configId: string, value: string | boolean) => {
        const sessionId = sessionRef.current;
        if (sessionId) post({ t: "session.config", sessionId, configId, value });
      },

      /** Reopen a past conversation from the sidebar. */
      openSession: (sessionId: string) => {
        sessionRef.current = sessionId;
        queued.current = undefined;
        setState((s) => {
          const session = s.sessions.find((entry) => entry.id === sessionId);
          if (!session) return s;
          return {
            ...s,
            sessionId,
            activeProviderId: session.providerId,
            turns: session.turns,
            busy: false,
          };
        });
      },

      /** Choose which agent the composer targets. Ends any open session. */
      select: (providerId: string) => {
        sessionRef.current = undefined;
        queued.current = undefined;
        setState((s) => ({
          ...s,
          activeProviderId: providerId,
          sessionId: undefined,
          turns: [],
          busy: false,
        }));
      },

      leave: () => {
        sessionRef.current = undefined;
        queued.current = undefined;
        setState((s) => ({ ...s, sessionId: undefined, turns: [], busy: false }));
      },
    }),
    [post],
  );

  return { ...state, ...actions };
}
