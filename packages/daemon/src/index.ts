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
import { connectProvider, type AcpSessionHandle } from "./acp/connect.js";
import { SessionLog } from "./session/log.js";
import { wire } from "@pew2/protocol";

interface ActiveSession {
  handle: AcpSessionHandle;
  log: SessionLog;
}

export class Daemon {
  private providers: LoadedProvider[] = [];
  private readonly sessions = new Map<string, ActiveSession>();
  private send: (message: unknown) => void = () => {};

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
