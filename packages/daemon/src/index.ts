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
import { readProbeCache, writeProbeCache } from "./probe-cache.js";
import { wire } from "@pew2/protocol";

interface ActiveSession {
  handle: AcpSessionHandle;
  log: SessionLog;
  /**
   * Whether clients have been told this session exists.
   *
   * Agents replay a resumed conversation's history *during* `session/load` —
   * before `connectProvider` resolves and long before the handler broadcasts
   * `session.started`. Events sent that early are dropped by clients as unknown
   * sessions, which is exactly how a resumed thread rendered empty. Until
   * `markLive`, events accumulate in the log unsent; `markLive` then flushes
   * them in order, after `session.started` has gone out.
   */
  live: boolean;
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

  /**
   * One already-booted agent process per provider, left over from the last
   * probe. Spawning is the slow part of opening a conversation — GG Coder
   * takes ~5s to boot while `session/load` answers in ~30ms — so the next
   * session *adopts* this process instead of paying the spawn again. A spare
   * idles out after `SPARE_TTL_MS` so an unused agent does not run forever.
   */
  private readonly spares = new Map<string, { handle: AcpSessionHandle; timer: NodeJS.Timeout }>();
  private static readonly SPARE_TTL_MS = 15 * 60 * 1000;

  /** A disk-cached probe older than this is refreshed in the background. */
  private static readonly REVALIDATE_AFTER_MS = 60 * 1000;

  /**
   * Refresh a provider's probe in the background and push the result.
   *
   * A failed refresh is silent: the cached answer stays in place rather than
   * being clobbered by an empty one.
   */
  private async revalidate(providerId: string) {
    const fresh = await this.probeProvider(providerId, { refresh: true });
    if (fresh === EMPTY_CAPABILITIES) return;
    // The app folds this into the drawer exactly like an answer to its own
    // request, so a stale list corrects itself moments after opening.
    this.send({ t: "provider.capabilities", providerId, ...fresh });
  }

  private stashSpare(providerId: string, handle: AcpSessionHandle) {
    const old = this.spares.get(providerId);
    if (old) {
      clearTimeout(old.timer);
      old.handle.close();
    }
    const timer = setTimeout(() => {
      this.spares.delete(providerId);
      handle.close();
    }, Daemon.SPARE_TTL_MS);
    // The timer must not keep the daemon process alive on its own.
    timer.unref?.();
    this.spares.set(providerId, { handle, timer });
  }

  private takeSpare(providerId: string): AcpSessionHandle | undefined {
    const spare = this.spares.get(providerId);
    if (!spare) return undefined;
    clearTimeout(spare.timer);
    this.spares.delete(providerId);
    return spare.handle;
  }

  /**
   * Connect a session to its agent, warm when possible.
   *
   * A dead spare (the process exited while idle) falls back to a cold spawn
   * rather than failing the open.
   */
  private async connectSession(
    session: ActiveSession,
    provider: LoadedProvider,
    cwd: string,
    loadSessionId: string | undefined,
  ): Promise<void> {
    const callbacks = {
      onUpdate: (payload: unknown) => this.record(session, payload),
      onPermissionRequest: ({ requestId, params }: { requestId: string; params: unknown }) =>
        this.record(session, { kind: "permission_request", requestId, params }),
      onExit: (code: number | null) => this.record(session, { kind: "exit", code }),
    };

    const spare = this.takeSpare(provider.manifest.id);
    if (spare) {
      try {
        await spare.adopt({ loadSessionId, ...callbacks });
        session.handle = spare;
      } catch {
        spare.close();
      }
    }
    if (!session.handle) {
      session.handle = await connectProvider({
        provider,
        cwd,
        loadSessionId,
        ...callbacks,
        onStderr: (line) => console.error(`[${provider.manifest.id}] ${line}`),
      });
    }

    // The spare is spent; quietly boot the next one so the session after this
    // opens instantly too. Failure here only means that open is cold again.
    void this.probeProvider(provider.manifest.id, { refresh: true }).catch(() => {});
  }

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

  /**
   * Append to the session's log, sending only once the session is live.
   *
   * The log gets every event either way — seqs stay gapless, so the flush in
   * `markLive` and the reconnect replay both see the complete history.
   */
  private record(session: ActiveSession, payload: unknown) {
    const event = session.log.append(payload);
    if (session.live) this.send(event);
  }

  /**
   * Tell clients about everything a session has already produced.
   *
   * Callers broadcast `session.started` first; this is what guarantees a client
   * never sees an event for a session it has not been introduced to.
   */
  markLive(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.live) return;
    session.live = true;
    // `since(-1)` is the whole log: everything held back while the agent was
    // connecting, replayed in seq order.
    for (const event of session.log.since(-1)) this.send(event);
  }

  async startSession(providerId: string, cwd: string): Promise<string> {
    const provider = this.providers.find((p) => p.manifest.id === providerId);
    if (!provider) throw new Error(`Unknown provider '${providerId}'`);
    if (!isAvailable(provider)) throw new Error(unavailableReason(provider)!);

    // Assign our own session id up front so events are attributable even if the
    // agent's own `session/new` is slow or fails.
    const log = new SessionLog(`${providerId}-${Date.now().toString(36)}`);
    // Registered before connecting so `record` has somewhere to hold events the
    // agent emits during the handshake itself.
    const session = { handle: undefined as unknown as AcpSessionHandle, log, live: false };
    this.sessions.set(log.sessionId, session);

    try {
      await this.connectSession(session, provider, cwd, undefined);
    } catch (error) {
      // A session that never connected has no history worth keeping, and
      // leaving it registered would answer prompts with a broken handle.
      this.sessions.delete(log.sessionId);
      throw error;
    }

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

    // A spawn plus session/list is seconds per provider. Serve the last good
    // answer from disk instantly and refresh it in the background instead of
    // making the drawer wait on the agent's boot time.
    if (!refresh) {
      const disk = await readProbeCache(providerId);
      if (disk) {
        if (Date.now() - disk.probedAt > Daemon.REVALIDATE_AFTER_MS) {
          void this.revalidate(providerId);
        }
        const served = Promise.resolve<ProviderCapabilities>({
          configOptions: disk.configOptions,
          sessions: disk.sessions,
          canResume: disk.canResume,
        });
        this.probes.set(providerId, served);
        return served;
      }
    }

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
        const capabilities: ProviderCapabilities = {
          configOptions: handle.configOptions,
          // The agent's own history, including everything started at the desk.
          sessions: await handle.listSessions(),
          canResume: handle.canLoadSession,
        };
        // Keep the booted process as the warm spare: the next session open
        // adopts it instead of paying the multi-second spawn again.
        this.stashSpare(providerId, handle);
        handle = undefined;
        // Persist so the next ask — and the next daemon boot — answers from
        // disk instead of spawning again.
        void writeProbeCache(providerId, capabilities).catch(() => {});
        return capabilities;
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
    const session = { handle: undefined as unknown as AcpSessionHandle, log, live: false };
    this.sessions.set(log.sessionId, session);

    try {
      // `session/load` replays the whole conversation here, before returning —
      // every one of those events lands in the log unsent, and `markLive`
      // delivers them after `session.started`.
      await this.connectSession(session, provider, cwd, agentSessionId);
    } catch (error) {
      this.sessions.delete(log.sessionId);
      throw error;
    }

    return log.sessionId;
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean) {
    // The handle updates its own advertised options, so late-joining clients
    // and the next probe both see the current values.
    return this.require(sessionId).handle.setConfigOption(configId, value);
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
    for (const session of this.sessions.values()) session.handle?.close();
    this.sessions.clear();
    for (const spare of this.spares.values()) {
      clearTimeout(spare.timer);
      spare.handle.close();
    }
    this.spares.clear();
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
