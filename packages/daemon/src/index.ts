/**
 * pew2 daemon.
 *
 * Runs on the user's machine. Owns provider discovery, agent processes, and the
 * per-session event log, then bridges all of it to the relay over one WebSocket.
 *
 * It is deliberately the fan-out point: ACP is a 1-client-to-1-agent protocol,
 * so the daemon — not the agent — is what lets a phone and a desktop observe the
 * same session at the same time.
 */
import { loadProviders, isAvailable, unavailableReason, type LoadedProvider } from "./providers/registry.js";
import {
  connectProvider,
  type AcpSessionHandle,
  type AgentSession,
  type ConfigOption,
} from "./acp/connect.js";
import { SessionLog } from "./session/log.js";
import { resolveWorkspace } from "./workspace.js";
import { wire } from "@pew2/protocol";

interface ActiveSession {
  handle: AcpSessionHandle;
  log: SessionLog;
}

/** Everything a provider can tell us before a conversation is under way. */
export interface ProviderCapabilities {
  configOptions: ConfigOption[];
  /** The agent's own stored conversations, newest first. */
  sessions: AgentSession[];
  /** Whether those sessions can actually be reopened. */
  canResume: boolean;
}

const EMPTY_CAPABILITIES: ProviderCapabilities = {
  configOptions: [],
  sessions: [],
  canResume: false,
};

export class Daemon {
  private providers: LoadedProvider[] = [];
  private readonly sessions = new Map<string, ActiveSession>();
  private send: (message: unknown) => void = () => {};
  // What a provider offers, learned by probing it: selectors, and the
  // conversations it already has on disk. Keyed by provider id, and stored in
  // flight rather than resolved so concurrent asks share one spawn.
  private readonly probes = new Map<string, Promise<ProviderCapabilities>>();

  constructor(
    private readonly machine: { id: string; name: string },
    private readonly includeExperimental = false,
  ) {}

  /** Point the daemon at a transport. Called with the relay socket's `send`. */
  attach(send: (message: unknown) => void) {
    this.send = send;
  }

  /** Rescan `providers/`. Safe to call at any time — this is what makes a newly
   *  added manifest show up on the phone without a restart. */
  async refreshProviders(): Promise<{ errors: { source: string; message: string }[] }> {
    const { providers, errors } = await loadProviders();
    this.providers = providers;
    this.announceProviders();
    return { errors };
  }

  private announceProviders() {
    const announce: wire.ProviderAnnounce = {
      t: "providers",
      machine: this.machine,
      providers: this.providers
        // Test fixtures are hidden unless explicitly asked for, so a demo or a
        // local run can still exercise the pipeline without any API keys.
        .filter((p) => !p.manifest.pew.experimental || this.includeExperimental)
        .map((p) => ({
          id: p.manifest.id,
          name: p.manifest.name,
          description: p.manifest.description,
          transport: p.manifest.pew.transport,
          color: p.manifest.pew.color,
          requiresWorkspace: p.manifest.pew.requiresWorkspace,
          available: isAvailable(p),
          unavailableReason: unavailableReason(p),
        })),
    };
    this.send(announce);
  }

  async startSession(providerId: string, cwd: string): Promise<string> {
    const provider = this.providers.find((p) => p.manifest.id === providerId);
    if (!provider) throw new Error(`Unknown provider '${providerId}'`);
    if (!isAvailable(provider)) throw new Error(unavailableReason(provider)!);

    // Assign our own session id up front so events are attributable even if the
    // agent's own `session/new` is slow or fails.
    const log = new SessionLog(`${providerId}-${Date.now().toString(36)}`);

    const handle = await connectProvider({
      provider,
      cwd,
      onUpdate: (payload) => this.send(log.append(payload)),
      onPermissionRequest: ({ requestId, params }) =>
        this.send(log.append({ kind: "permission_request", requestId, params })),
      onStderr: (line) => console.error(`[${providerId}] ${line}`),
      onExit: (code) => this.send(log.append({ kind: "exit", code })),
    });

    this.sessions.set(log.sessionId, { handle, log });
    return log.sessionId;
  }

  /** Selectors (model, thinking level, mode) advertised by a session's agent. */
  configOptions(sessionId: string) {
    return this.sessions.get(sessionId)?.handle.configOptions ?? [];
  }

  /**
   * Ask a provider what it currently offers, without starting a conversation.
   *
   * Selectors are a property of a live session, so the only honest way to learn
   * them is to open one and throw it away. That keeps the model list true after
   * the connected app updates — pew2 stores no model names of its own — and lets
   * the empty state show real options instead of nothing.
   *
   * Cached per provider for the daemon's lifetime: spawning an agent is slow,
   * and a live session's own selectors always take precedence over this.
   */
  async probeProvider(
    providerId: string,
    { refresh = false } = {},
  ): Promise<ProviderCapabilities> {
    if (refresh) this.probes.delete(providerId);
    const cached = this.probes.get(providerId);
    if (cached) return cached;

    const provider = this.providers.find((p) => p.manifest.id === providerId);
    if (!provider || !isAvailable(provider)) return EMPTY_CAPABILITIES;

    const probe = (async (): Promise<ProviderCapabilities> => {
      let handle: AcpSessionHandle | undefined;
      try {
        handle = await connectProvider({
          provider,
          // Same rule as session.start: under launchd cwd is `/`, which is not a
          // project directory. Probing from it hid every agent's sessions.
          cwd: resolveWorkspace(),
          // A probe session is never shown, so its output goes nowhere.
          onUpdate: () => {},
          onPermissionRequest: () => {},
        });
        return {
          configOptions: handle.configOptions,
          // The agent's own history, including everything started at the desk.
          sessions: await handle.listSessions(),
          canResume: handle.canLoadSession,
        };
      } catch (error) {
        // A probe is best-effort: this is what the app shows before a session
        // exists, and failing here must not stop the user starting a real one.
        console.error(`[${providerId}] capability probe failed:`, error);
        this.probes.delete(providerId);
        return EMPTY_CAPABILITIES;
      } finally {
        handle?.close();
      }
    })();

    this.probes.set(providerId, probe);
    return probe;
  }

  /**
   * Open one of the agent's own past conversations.
   *
   * `session/load` replays its history as ordinary `session/update` events, so
   * they land in the log and reach every client exactly like live output — a
   * resumed thread and a fresh one are the same thing downstream.
   */
  async resumeSession(providerId: string, agentSessionId: string, cwd: string) {
    const provider = this.providers.find((p) => p.manifest.id === providerId);
    if (!provider) throw new Error(`Unknown provider '${providerId}'`);
    if (!isAvailable(provider)) throw new Error(unavailableReason(provider)!);

    const log = new SessionLog(`${providerId}-${Date.now().toString(36)}`);
    const handle = await connectProvider({
      provider,
      cwd,
      loadSessionId: agentSessionId,
      onUpdate: (payload) => this.send(log.append(payload)),
      onPermissionRequest: ({ requestId, params }) =>
        this.send(log.append({ kind: "permission_request", requestId, params })),
      onStderr: (line) => console.error(`[${providerId}] ${line}`),
      onExit: (code) => this.send(log.append({ kind: "exit", code })),
    });

    this.sessions.set(log.sessionId, { handle, log });
    return log.sessionId;
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean) {
    const session = this.require(sessionId);
    const updated = await session.handle.setConfigOption(configId, value);
    // Keep the handle authoritative so late-joining clients see current values.
    session.handle.configOptions = updated;
    return updated;
  }

  async prompt(sessionId: string, text: string) {
    const session = this.require(sessionId);
    // Echo the user's own message into the log so every client renders it,
    // including the ones that did not send it.
    this.send(session.log.append({ kind: "user_message", text }));
    await session.handle.prompt(text);
  }

  async cancel(sessionId: string) {
    await this.require(sessionId).handle.cancel();
  }

  answerPermission(sessionId: string, requestId: string, optionId: string) {
    return this.require(sessionId).handle.answerPermission(requestId, optionId);
  }

  /** Replay everything a reconnecting client has not seen yet. */
  replay(sessionId: string, cursor: number): wire.SessionEvent[] {
    return this.sessions.get(sessionId)?.log.since(cursor) ?? [];
  }

  closeAll() {
    for (const session of this.sessions.values()) session.handle.close();
    this.sessions.clear();
  }

  private require(sessionId: string): ActiveSession {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session '${sessionId}'`);
    return session;
  }
}

if (import.meta.main) {
  const daemon = new Daemon({ id: "local", name: "this machine" });
  daemon.attach((message) => console.log(JSON.stringify(message)));

  const { errors } = await daemon.refreshProviders();
  for (const error of errors) console.error(error.message);

  process.on("SIGINT", () => {
    daemon.closeAll();
    process.exit(0);
  });
}
