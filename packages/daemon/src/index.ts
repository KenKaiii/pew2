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
  type AvailableCommand,
  type ConfigOption,
} from "./acp/connect.js";
import { loadClaudeDisplayHistory } from "./acp/claude-history.js";
import { readTranscript, writeTranscript } from "./transcript-cache.js";
import { loadGgCoderDisplayHistory } from "./acp/ggcoder-history.js";
import { SessionLog } from "./session/log.js";
import { readDisabled } from "./providers/enabled.js";
import { discardAttachments, storeAttachments } from "./attachments.js";
import { folderName, resolveWorkspace } from "./workspace.js";
import { readProbeCache, writeProbeCache } from "./probe-cache.js";
import { hydrateMessageCounts } from "./acp/messageCounts.js";
import { sessionsInProject, type AgentProject } from "./projects.js";
import { SESSION_HISTORY_LIMIT } from "./session-history.js";
import { readConfigPrefs, writeConfigPref, type ConfigPrefs } from "./config-prefs.js";
import { readSessionPrefs, writeSessionPrefs } from "./session-prefs.js";
import { readCommandDirs } from "./commands/from-disk.js";
import { wire } from "@pew2/protocol";

interface ActiveSession {
  handle?: AcpSessionHandle;
  log: SessionLog;
  /** Which agent this belongs to, so a config change knows what to remember. */
  providerId: string;
  /**
   * The agent's own id for this conversation, learned once it is open.
   *
   * Session ids here are the daemon's, assigned before the agent answers, so
   * this is the only thing that identifies the *same conversation* across a
   * restart — it keys the per-session selectors and lets the app collapse the
   * agent's disk-history stub onto the live session instead of listing both.
   */
  agentSessionId?: string;
  /**
   * The directory the agent was started in.
   *
   * Kept because agent output names files relative to it — an image the agent
   * generated is `.gg/generated/x.png` and nothing else, so serving it to the
   * phone needs the root that path was written against.
   */
  cwd: string;
  /** Resolves once the agent has loaded and can accept prompts/config changes. */
  ready: Promise<void>;
  /** Whether clients have been told this session exists. */
  live: boolean;
  /**
   * When this conversation was last opened, prompted, or answered.
   *
   * A session holds a whole agent process — GG Coder measures 90-330MB, Claude
   * Code 350MB+ — and nothing used to end one. Every conversation opened in a
   * run left its agent resident until the daemon died, which on a machine left
   * running for a day meant eleven GG Coder processes and 2.2GB for
   * conversations last touched hours earlier.
   *
   * Reaping needs this rather than the log's last entry because opening a
   * conversation and reading it is use, and produces no events at all.
   */
  lastUsedAt: number;
  /**
   * A turn is in flight.
   *
   * The agent is working even when it is silent — thinking, or running a long
   * tool — so elapsed quiet is not evidence a session can be closed. This is
   * the flag that keeps the reaper off a running turn.
   */
  working?: boolean;
  /** Resume history is frame-batched until loading completes. */
  streamingReplay?: boolean;
  pendingReplay?: wire.SessionEvent[];
  replayTimer?: NodeJS.Timeout;
}

/** Everything a provider can tell us before a conversation is under way. */
export interface ProviderCapabilities {
  configOptions: ConfigOption[];
  /** The agent's own stored conversations, newest first. */
  sessions: AgentSession[];
  /** Whether those sessions can actually be reopened. */
  canResume: boolean;
  /**
   * Slash commands the agent offers for this project.
   *
   * Learned from the throwaway probe session, so the app can offer them in the
   * empty state — before the first prompt has created a session to ask.
   */
  commands?: AvailableCommand[];
  /**
   * Every project the agent holds history for, newest first.
   *
   * Folded from the whole session list rather than the capped `sessions`
   * above, so the phone's project menu is complete even when a single repo
   * fills the recent history.
   */
  projects?: AgentProject[];
}

/**
 * Show a selector at the value it will actually take.
 *
 * A stored preference is applied when a session opens, so a capability reply
 * that reported the agent's default would be describing a state that never
 * reaches the screen. Only values the option really offers are used: a model
 * dropped between agent versions must not leave a pill naming something that
 * cannot be chosen.
 */
export function withStoredPrefs(
  options: ConfigOption[],
  prefs: Record<string, string | boolean>,
): ConfigOption[] {
  return options.map((option) => {
    const preferred = prefs[option.id];
    if (preferred === undefined) return option;
    const offered =
      !option.options || option.options.some((choice) => choice.value === preferred);
    return offered ? { ...option, currentValue: preferred } : option;
  });
}

const EMPTY_CAPABILITIES: ProviderCapabilities = {
  configOptions: [],
  sessions: [],
  canResume: false,
  commands: [],
  projects: [],
};

/**
 * How many of a project's conversations the phone is offered.
 *
 * The same window the drawer already applies to recent history: a project is
 * chosen to get back to work in it, not to browse a year of archives.
 */
const PROJECT_SESSION_LIMIT = SESSION_HISTORY_LIMIT;

const REPLAY_BATCH_SIZE = 64;

export class Daemon {
  private providers: LoadedProvider[] = [];
  private readonly sessions = new Map<string, ActiveSession>();
  private send: (message: unknown) => void = () => {};
  // What a provider offers, learned by probing it: selectors, and the
  // conversations it already has on disk. Keyed by provider id, and stored in
  // flight rather than resolved so concurrent asks share one spawn.
  private readonly probes = new Map<string, Promise<ProviderCapabilities>>();
  /**
   * Every session a provider reported, uncapped, keyed by provider id.
   *
   * The app is only ever sent the newest handful, because message counts cost
   * a disk read each. Choosing a project then needs a *different* handful —
   * one repo's newest — and this is what answers that without spawning the
   * agent again.
   */
  private readonly projectHistory = new Map<string, AgentSession[]>();

  /**
   * Directories recently shown to a browsing client.
   *
   * A path only becomes a "known project" once a session exists in it, so a
   * folder reached by browsing would otherwise be unrecognised at exactly the
   * moment it is chosen. Insertion-ordered and capped, so it stays an echo check
   * rather than a growing record of what is on the disk.
   */
  private readonly offeredWorkspaces = new Set<string>();

  /**
   * One already-booted agent process per provider, left over from the last
   * probe. Spawning is the slow part of opening a conversation — GG Coder
   * takes ~5s to boot while `session/load` answers in ~30ms — so the next
   * session *adopts* this process instead of paying the spawn again. A spare
   * idles out after `SPARE_TTL_MS` so an unused agent does not run forever.
   */
  private readonly spares = new Map<
    // Keyed by provider *and* directory. `cwd` is part of a spare's identity
    // rather than a note about it: some agents ignore ACP's per-session `cwd`
    // and run wherever their process was spawned, so a warm process is only
    // reusable for the project it was booted for.
    //
    // Keyed by provider alone, only one project could be warm at a time, and
    // opening a conversation in any other one paid a full cold spawn — two to
    // three seconds of staring at an empty thread.
    string,
    { handle: AcpSessionHandle; timer: NodeJS.Timeout; cwd: string; providerId: string }
  >();
  /**
   * At most this many warm processes per provider, oldest evicted first.
   *
   * One, not three. A warm agent is a whole language server: opencode measures
   * 326-491MB each, so three per provider is over a gigabyte idling for one
   * agent nobody is talking to.
   *
   * Three was worth trying when a spare was the only thing standing between a
   * tap and an empty screen. It is not any more \u2014 the transcript cache paints
   * the conversation from disk immediately and the agent reconnects behind it,
   * so a missed spare now costs a background reconnect rather than a visible
   * wait. Memory is the harder constraint, and this is the side to err on.
   */
  private static readonly MAX_SPARES_PER_PROVIDER = 1;
  /** Provider boots already in flight, shared by a tap instead of duplicated. */
  private readonly warming = new Map<string, Promise<void>>();
  /**
   * Resolves as soon as a boot has a usable process, well before the probe it
   * belongs to has finished listing history.
   *
   * These used to be one promise, so the first tap waited on a `session/list`
   * plus a message count read for every stored conversation — seconds of disk
   * work that opening a new conversation does not need at all.
   */
  private readonly spareReady = new Map<
    string,
    { ready: Promise<void>; announce: () => void }
  >();
  private static readonly SPARE_TTL_MS = 15 * 60 * 1000;

  /**
   * How long a conversation may sit untouched before its agent is closed.
   *
   * The same fifteen minutes as a warm spare, and for the same reason: what is
   * being held is a process, and the conversation itself is on disk. Reopening
   * one measures ~1.1s — and the thread paints from cache first, so that second
   * is spent behind a screen the user is already reading.
   *
   * This started at an hour, which was too timid to be worth much: an agent is
   * 90-370MB, and a morning's work leaves several of them parked long before an
   * hour is up. Comparable tools are tighter still — openclaw evicts at ten
   * minutes, and paperclip, which speaks the same ACP protocol, tears the
   * process down after every single run.
   *
   * Nothing bounded these at all before. Every conversation opened held its
   * agent until the daemon died, so an afternoon of testing accumulated eleven
   * GG Coder processes and 2.2GB for conversations nobody had touched in hours.
   */
  private static readonly SESSION_TTL_MS = 15 * 60 * 1000;
  /**
   * How often the reaper looks.
   *
   * Two minutes, so the sweep is a rounding error on the window rather than a
   * silent extension of it: a five-minute tick would make a fifteen-minute TTL
   * mean twenty in the worst case.
   */
  private static readonly REAP_INTERVAL_MS = 2 * 60 * 1000;
  private reaper?: NodeJS.Timeout;
  /**
   * How many conversations may hold an agent process at once.
   *
   * The time limit alone does not bound memory, it only bounds *lingering*.
   * Someone working through a morning — a task here, a new one in another
   * project, a third to check something — opens conversations faster than any
   * idle clock retires them, and ten live agents is roughly two gigabytes.
   *
   * Four, because that is about as many conversations as a person actually has
   * in play at once, and closing one is cheap: the transcript is on disk and the
   * agent keeps its own history, so returning to it resumes. The cost of being
   * wrong is a few seconds of reconnect on an old conversation; the cost of no
   * cap is the machine.
   */
  private static readonly MAX_LIVE_SESSIONS = 4;

  /**
   * Boot a provider in the background, refresh its cache, and push the result.
   * A failed refresh is silent: the cached answer stays in place.
   */
  private async revalidate(providerId: string) {
    const fresh = await this.probeProvider(providerId, { refresh: true });
    if (fresh === EMPTY_CAPABILITIES) return;
    // The app folds this into the drawer exactly like an answer to its own
    // request, so a stale list corrects itself moments after opening.
    this.send({ t: "provider.capabilities", providerId, ...fresh });
  }

  /**
   * Boot a spare in a specific directory, in the background.
   *
   * Separate from `warmProvider`, which exists to refresh capabilities and can
   * only ever warm the probe's own workspace.
   */
  private async warmSpareFor(provider: LoadedProvider, cwd: string): Promise<void> {
    if (this.spares.has(Daemon.spareKey(provider.manifest.id, cwd))) return;
    try {
      const handle = await connectProvider({
        provider,
        cwd,
        onUpdate: () => {},
        onPermissionRequest: () => {},
      });
      this.stashSpare(provider.manifest.id, handle, cwd);
    } catch {
      // Best effort. The next conversation here spawns cold, which is the
      // behaviour this is trying to improve on rather than depend on.
    }
  }

  private warmProvider(providerId: string): Promise<void> {
    // Nothing is warmed for an agent that is off. Without this the daemon would
    // still boot a process for it in the background, which is most of what
    // turning it off was meant to avoid.
    if (!this.isEnabled(providerId)) return Promise.resolve();
    // Any warm process for this provider is enough to skip the boot; the
    // directory match is `takeSpare`'s business, not this one's.
    if (this.hasSpare(providerId)) {
      // A spare is already waiting, so anyone armed by a probe that took the
      // disk-cache path has nothing left to wait for. Releasing here is what
      // stops `awaitSpare` blocking on a boot that will never be started.
      this.spareReady.get(providerId)?.announce();
      this.spareReady.delete(providerId);
      return Promise.resolve();
    }
    const existing = this.warming.get(providerId);
    if (existing) return existing;
    // Armed before the probe starts, not inside it: `probeProvider` awaits the
    // disk cache first, so a tap arriving in that window would find no promise
    // to wait on and spawn a second process alongside this one.
    this.armSpare(providerId);
    const warming = this.revalidate(providerId).finally(() => {
      if (this.warming.get(providerId) === warming) this.warming.delete(providerId);
      // Release anyone still waiting; a finished boot either left a spare or
      // failed, and both answers are "stop waiting".
      this.spareReady.get(providerId)?.announce();
      this.spareReady.delete(providerId);
    });
    this.warming.set(providerId, warming);
    return warming;
  }

  /** The pending boot for a provider, created on first use. */
  private armSpare(providerId: string) {
    const existing = this.spareReady.get(providerId);
    if (existing) return existing;
    let announce!: () => void;
    const ready = new Promise<void>((resolve) => {
      announce = resolve;
    });
    const entry = { ready, announce };
    this.spareReady.set(providerId, entry);
    return entry;
  }

  /**
   * Publish the project's own command files alongside whatever the agent sent.
   *
   * Merged rather than used only on silence: a command file is something the
   * user wrote in *this* project a moment ago, and an agent that enumerated its
   * built-ins at startup may not have noticed it. The agent's own entry wins on
   * a name collision, since only it knows what its built-in actually does.
   *
   * Emitted as the same `available_commands_update` an agent would send, so
   * clients keep one path for commands rather than a second, special one.
   *
   * This is where the workspace is real. The capability probe runs from the
   * daemon's cwd — `/` under launchd, so `resolveWorkspace()` gives home — and
   * therefore has no project to read.
   */
  private async announceDiskCommands(
    session: ActiveSession,
    provider: LoadedProvider,
    cwd: string,
  ) {
    const dirs = provider.manifest.pew.commandDirs;
    if (dirs.length === 0) return;

    const advertised = session.handle?.availableCommands ?? [];
    const known = new Set(advertised.map((command) => command.name));
    const fromDisk = (await readCommandDirs(dirs, cwd)).filter(
      (command) => !known.has(command.name),
    );
    if (fromDisk.length === 0) return;

    const commands = [...advertised, ...fromDisk];

    // The agent's own envelope, verbatim: the app reads `payload.update`, and a
    // bare update here would be a second shape it had to learn.
    this.record(session, {
      sessionId: session.handle?.sessionId,
      update: {
        sessionUpdate: "available_commands_update",
        availableCommands: commands,
      },
    });
  }

  /**
   * Tell clients the agent changed the session's selectors by itself.
   *
   * Sent as the same `session.config` a client's own change is answered with,
   * so the app keeps one path for "these are the current selectors". Deliberately
   * outside the seq'd log: this is current state, not a transcript entry, and a
   * reconnecting client is told the live set when its session starts.
   *
   * It matters most for thinking. The option set is model-dependent, so the
   * thinking-level selector only exists while a model that supports one is
   * current — the agent announces its arrival and departure this way, and
   * nowhere else.
   *
   * Nothing is written to `session-prefs.json` here, unlike `setConfigOption`.
   * That file replays a *user's* choices over the defaults a resumed session
   * comes back with, and this list is the agent's own state — recording it
   * would turn a conversation with no record into one with a full record, which
   * is then replayed over whatever it was later changed to at the desk.
   */
  private publishConfigOptions(session: ActiveSession, configOptions: ConfigOption[]) {
    if (!session.live) return;
    this.send({
      t: "session.config",
      sessionId: session.log.sessionId,
      providerId: session.providerId,
      configOptions,
    });
  }

  /** Wait only for a warm process, never for the history probe around it. */
  private async awaitSpare(providerId: string): Promise<void> {
    await this.spareReady.get(providerId)?.ready;
  }

  /**
   * The directories a provider currently has a warm process in.
   *
   * Exposed for tests, which previously reached into the private map by
   * provider id \u2014 so keying spares by directory broke three of them without
   * any behaviour changing. An accessor keeps them honest about what they are
   * really asserting.
   */
  spareDirs(providerId: string): string[] {
    const prefix = `${providerId}\u0000`;
    return [...this.spares.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([, spare]) => spare.cwd);
  }

  /** Whether any warm process exists for a provider, in any directory. */
  private hasSpare(providerId: string): boolean {
    for (const key of this.spares.keys()) if (key.startsWith(`${providerId}\u0000`)) return true;
    return false;
  }

  /** The map key for a warm process. */
  private static spareKey(providerId: string, cwd: string): string {
    return `${providerId}\u0000${cwd}`;
  }

  private stashSpare(providerId: string, handle: AcpSessionHandle, cwd: string) {
    const key = Daemon.spareKey(providerId, cwd);
    const old = this.spares.get(key);
    if (old) {
      clearTimeout(old.timer);
      old.handle.close();
      // Removed as well as closed, so the eviction pass below does not find it
      // and close the same process a second time.
      this.spares.delete(key);
    }

    // Bounded per provider, oldest first. Each spare is a live agent process
    // holding memory and a model connection, so "keep one per project" cannot
    // mean "keep one per project the user has ever opened".
    const mine = [...this.spares.keys()].filter((k) => k.startsWith(`${providerId}\u0000`));
    while (mine.length >= Daemon.MAX_SPARES_PER_PROVIDER) {
      const evict = mine.shift()!;
      const spare = this.spares.get(evict);
      if (spare) {
        clearTimeout(spare.timer);
        spare.handle.close();
        this.spares.delete(evict);
      }
    }

    const timer = setTimeout(() => {
      this.spares.delete(key);
      handle.close();
    }, Daemon.SPARE_TTL_MS);
    // The timer must not keep the daemon process alive on its own.
    timer.unref?.();
    this.spares.set(key, { handle, timer, cwd, providerId });
  }

  /**
   * A warm process for this provider, but only if it is already in the right
   * directory.
   *
   * The cwd check is the whole point. ACP passes a `cwd` with every
   * `session/new`, and well-behaved agents honour it — but several do not, and
   * simply run wherever their process was started. Adopting one of those for a
   * different project produced an agent that looked connected and correct while
   * reading and writing entirely the wrong tree, which is about the worst
   * failure this daemon could have.
   *
   * A mismatch is left in place rather than closed: it may still be adopted by
   * the next session in its own project, and `SPARE_TTL_MS` reaps it otherwise.
   *
   * The cost is real and worth stating: spares are only ever booted by the
   * capability probe, which runs in `resolveWorkspace()` — the home directory
   * under launchd. A conversation opened in an actual project therefore misses
   * the warm path and pays the cold spawn. That is the right way round. A few
   * seconds of boot is a worse outcome than an agent confidently editing the
   * wrong repository, and the previous behaviour bought its speed by doing
   * exactly that.
   */
  private takeSpare(providerId: string, cwd: string): AcpSessionHandle | undefined {
    const key = Daemon.spareKey(providerId, cwd);
    const spare = this.spares.get(key);
    if (!spare) return undefined;
    clearTimeout(spare.timer);
    this.spares.delete(key);
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
      onConfigOptions: (configOptions: ConfigOption[]) =>
        this.publishConfigOptions(session, configOptions),
      onExit: (code: number | null) => this.record(session, { kind: "exit", code }),
    };

    // Paint local JSONL history immediately for providers whose ACP load path
    // scans or initializes before replay. Suppress only that duplicate history;
    // the attached agent remains authoritative for config and all live updates.
    const localUpdates = loadSessionId
      ? provider.manifest.id === "claude-code"
        ? (await loadClaudeDisplayHistory(loadSessionId, cwd))?.map((message) => ({
            sessionUpdate:
              message.role === "user" ? "user_message_chunk" : "agent_message_chunk",
            // An array only when there are pictures to carry: the single block
            // is the shape every other replay path emits.
            content:
              message.images.length > 0
                ? [{ type: "text", text: message.text }, ...message.images]
                : { type: "text", text: message.text },
          }))
        : provider.manifest.id === "ggcoder"
          ? await loadGgCoderDisplayHistory(loadSessionId, cwd)
          : // Every other agent, from what it replayed last time. Without this
            // the thread sat empty for the whole cold spawn — measured at 3.2s
            // on GitHub Copilot against Claude Code's 28ms, purely because
            // Claude keeps a transcript on disk and the others do not.
            await readTranscript(provider.manifest.id, loadSessionId)
      : undefined;
    if (localUpdates) {
      for (const update of localUpdates) {
        callbacks.onUpdate({ sessionId: loadSessionId, update });
      }
    }
    // Already on screen, so the agent does not need to send it again. Agents
    // that offer `session/resume` are asked to restore context without the
    // replay; the rest still replay and it is still discarded below.
    const haveHistory = localUpdates !== undefined;
    let loadingDuplicateReplay = haveHistory;
    // What the agent sends while loading, kept so this conversation opens from
    // disk next time. Only collected when there was no cache to begin with:
    // re-writing what was just read would grow the file on every open.
    const replayed: unknown[] = [];
    const collectReplay = Boolean(loadSessionId) && localUpdates === undefined;
    const agentCallbacks = {
      ...callbacks,
      onUpdate: (payload: unknown) => {
        if (collectReplay && !session.live) replayed.push(payload);
        if (!loadingDuplicateReplay) callbacks.onUpdate(payload);
      },
    };

    let spare = this.takeSpare(provider.manifest.id, cwd);
    if (!spare) {
      // Join the background boot started alongside a disk-cached history list
      // instead of spawning a duplicate process on tap. Only the process is
      // waited for: the probe's own `session/list` keeps running behind this.
      await this.awaitSpare(provider.manifest.id);
      spare = this.takeSpare(provider.manifest.id, cwd);
    }
    if (spare) {
      try {
        // `cwd` is what makes the spare usable for this conversation: the warm
        // process was booted for the probe's workspace, not this project.
        await spare.adopt({ loadSessionId, cwd, haveHistory, ...agentCallbacks });
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
        haveHistory,
        ...agentCallbacks,
        onStderr: (line) => console.error(`[${provider.manifest.id}] ${line}`),
      });
    }
    loadingDuplicateReplay = false;
    // The agent's own id for the conversation, which is what the per-session
    // selectors below are keyed by and what the app dedupes history against.
    session.agentSessionId = session.handle.sessionId;

    // Stored under the agent's id rather than the one asked for: resuming can
    // hand back a different id, and the next open will ask by that one.
    if (collectReplay && replayed.length > 0) {
      void writeTranscript(provider.manifest.id, session.handle.sessionId, replayed);
    }

    // A reopened conversation gets the selectors *it* was last held at; a new
    // one gets the provider's. Never the other way round: applying the phone's
    // last pick to a thread started at the desk would rewrite it silently.
    const restored = loadSessionId
      ? await this.applySessionPrefs(session, provider.manifest.id, loadSessionId)
      : await this.applyConfigPrefs(session, provider.manifest.id);
    // Remember what this conversation is now running, so reopening it restores
    // the same thing even though `session/load` reports the agent's defaults.
    if (session.agentSessionId) {
      void writeSessionPrefs(provider.manifest.id, session.agentSessionId, restored).catch(
        () => {},
      );
    }
    await this.announceDiskCommands(session, provider, cwd);

    // The spare is spent; quietly boot the next one so the session after this
    // opens instantly too. Failure here only means that open is cold again.
    //
    // Warmed for *this* project, not the probe's. `warmProvider` re-runs the
    // capability probe, which always boots in `resolveWorkspace()` — so on its
    // own it leaves the directory the user is actually working in permanently
    // cold, and every conversation there pays the spawn again.
    void this.warmSpareFor(provider, cwd);
  }

  /**
   * Re-apply the selectors this user last chose for the provider.
   *
   * ACP hands every new session the agent's own defaults, so without this,
   * picking a model and starting the next conversation silently reverts it.
   * Awaited, so `session.started` already carries the restored values and the
   * pills never show the default for a frame first.
   *
   * New sessions only — see the call site. Returns the selectors this session
   * ended up holding, which is what gets recorded against the conversation.
   */
  private async applyConfigPrefs(
    session: ActiveSession,
    providerId: string,
  ): Promise<ConfigPrefs> {
    return this.applyPrefs(session, providerId, await readConfigPrefs(providerId));
  }

  /**
   * Re-apply the selectors this *conversation* was last held at.
   *
   * `session/load` replays the transcript but not the session's settings — the
   * agent hands back its defaults — so without this, leaving a conversation and
   * coming back reverted the model every time.
   */
  private async applySessionPrefs(
    session: ActiveSession,
    providerId: string,
    agentSessionId: string,
  ): Promise<ConfigPrefs> {
    const prefs = await readSessionPrefs(providerId, agentSessionId);
    // Nothing recorded means this conversation was never configured from here:
    // whatever the agent reports is the honest answer, and the provider's
    // default is emphatically not.
    if (Object.keys(prefs).length === 0) return {};
    return this.applyPrefs(session, providerId, prefs);
  }

  /** Set every stored selector the session actually offers, and report them. */
  private async applyPrefs(
    session: ActiveSession,
    providerId: string,
    prefs: ConfigPrefs,
  ): Promise<ConfigPrefs> {
    const handle = session.handle;
    if (!handle) return {};
    const applied: ConfigPrefs = {};

    for (const [configId, value] of Object.entries(prefs)) {
      const option = handle.configOptions.find((o) => o.id === configId);
      // Only what this session actually offers: an agent that dropped an option
      // between versions must not break the session, and a value it no longer
      // lists must not be recorded as this conversation's choice.
      if (!option) continue;
      const offered =
        !option.options || option.options.some((choice) => choice.value === value);
      if (!offered) continue;
      // Already right: re-sending it is a round trip for nothing, but it is
      // still what the session holds.
      if (option.currentValue === value) {
        applied[configId] = value;
        continue;
      }
      try {
        await handle.setConfigOption(configId, value);
        applied[configId] = value;
      } catch (error) {
        // A stale preference is not worth failing a session over. The agent
        // keeps its default and the user can pick again.
        console.error(`[${providerId}] could not restore '${configId}':`, error);
      }
    }
    return applied;
  }

  /**
   * Where this daemon's files live, fixed at construction.
   *
   * The probe cache path is derived from `PEW2_HOME`, and the background refresh
   * that follows a cache hit outlives the call that started it. Reading the
   * ambient environment when that write finally lands means it goes to whatever
   * home is installed *then* rather than the one this daemon was built for — so
   * a refresh could overwrite a cache belonging to something else entirely.
   *
   * In production nothing ever moves `PEW2_HOME`, so this is the same value
   * either way. It matters wherever more than one home exists in a process,
   * which is every test that works in a temporary directory.
   */
  private readonly env: NodeJS.ProcessEnv;

  constructor(
    private readonly machine: { id: string; name: string },
    private readonly includeExperimental = false,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    // Copied, not referenced: the point is a value that cannot change under a
    // write that lands later.
    this.env = { ...env };
  }

  /** Point the daemon at a transport. Called with the relay socket's `send`. */
  attach(send: (message: unknown) => void) {
    this.send = send;
    // Started here rather than in the constructor so building a Daemon in a test
    // does not leave a timer running. `unref` for the same reason: this must
    // never be the thing keeping the process alive.
    if (!this.reaper) {
      this.reaper = setInterval(() => this.reapIdleSessions(), Daemon.REAP_INTERVAL_MS);
      this.reaper.unref?.();
    }
  }

  /**
   * Close agents for conversations nobody has touched in a long time.
   *
   * The process is the expensive part, not the conversation: the transcript is
   * on disk and the agent keeps its own history, so a closed session reopens by
   * resuming. What is being reclaimed is a language server sitting at 90-370MB
   * for a chat that was finished hours ago.
   *
   * Clients are told through the ordinary `providers` announce, whose
   * `activeSessions` is exactly the list of sessions this process still holds.
   * The app already reacts to an id disappearing from it — that is how it
   * survives a daemon restart — and resumes the conversation on screen instead
   * of prompting an id that no longer exists. Reaping deliberately reuses that
   * path rather than inventing a second one, so an older app on TestFlight
   * handles this correctly too.
   *
   * @param now Injectable for tests; the reaper is on an hour-long clock.
   * @returns The session ids closed.
   */
  reapIdleSessions(now: number = Date.now()): string[] {
    const reaped: string[] = [];
    for (const [sessionId, session] of this.sessions) {
      // A turn in flight is never idle, however quiet it has gone: an agent can
      // spend minutes inside one tool call without emitting anything.
      if (session.working) continue;
      if (now - session.lastUsedAt < Daemon.SESSION_TTL_MS) continue;
      // Nothing to resume from means nothing to come back to. A conversation
      // the agent never named would be lost rather than closed, so it is kept
      // — these are rare and short-lived, since the id arrives during the
      // handshake.
      if (!session.agentSessionId) continue;
      if (session.replayTimer) clearTimeout(session.replayTimer);
      session.handle?.close();
      this.sessions.delete(sessionId);
      reaped.push(sessionId);
    }
    // Announce once for the whole pass, not once per session: the message is a
    // full snapshot, so repeating it per id would be the same list several times.
    if (reaped.length > 0) this.announceProviders();
    return reaped;
  }

  /**
   * Close the least recently used conversations until only `MAX_LIVE_SESSIONS`
   * hold an agent. Called as a new one opens, so the ceiling is enforced at the
   * moment memory would actually grow rather than up to five minutes later.
   *
   * Least recently *used*, not oldest: a conversation started this morning and
   * still being worked in outranks one opened ten minutes ago and abandoned.
   *
   * @param exempt The session being opened, which must never be the one closed.
   * @returns The session ids closed.
   */
  private enforceSessionCap(exempt: string): string[] {
    const closable = [...this.sessions.entries()]
      // Same three exclusions the reaper uses, for the same reasons: a turn in
      // flight would lose work, and a conversation the agent never named has
      // nothing to resume from, so closing it loses it rather than parks it.
      .filter(([id, s]) => id !== exempt && !s.working && s.agentSessionId !== undefined)
      .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);

    const excess = this.sessions.size - Daemon.MAX_LIVE_SESSIONS;
    const closed: string[] = [];
    for (const [sessionId, session] of closable.slice(0, Math.max(0, excess))) {
      if (session.replayTimer) clearTimeout(session.replayTimer);
      session.handle?.close();
      this.sessions.delete(sessionId);
      closed.push(sessionId);
    }
    // Same announce the reaper sends, and for the same reason: `activeSessions`
    // is how a client learns an id it still lists no longer exists here. Without
    // it the phone would keep offering a conversation whose agent is gone and
    // prompt it, which fails with "Unknown session" instead of resuming.
    if (closed.length > 0) this.announceProviders();
    return closed;
  }

  /** Rescan `providers/`. Safe to call at any time — this is what makes a newly
   *  added manifest show up on the phone without a restart. */
  async refreshProviders(): Promise<{ errors: { source: string; message: string }[] }> {
    const { providers, errors } = await loadProviders();
    this.providers = providers;
    // Re-read every refresh, so `pew2 providers disable` takes effect without
    // restarting the daemon.
    this.disabled = await readDisabled();
    this.closeDisabled();
    this.announceProviders();
    return { errors };
  }

  /**
   * Stop agents the user has just turned off.
   *
   * Turning one off only ever stopped it being announced, probed or spawned
   * *next* time. Anything already running kept running, so a machine that had
   * warmed Cline and Qwen before they were deselected still had both resident
   * hours later — which reads as the switch not working, and is the whole
   * reason someone turns an agent off.
   */
  private closeDisabled() {
    for (const [key, spare] of this.spares) {
      if (this.isEnabled(spare.providerId)) continue;
      clearTimeout(spare.timer);
      spare.handle.close();
      this.spares.delete(key);
    }
    for (const [sessionId, session] of this.sessions) {
      if (this.isEnabled(session.providerId)) continue;
      // A turn in flight is left alone. Killing an agent mid-answer would lose
      // work the user is waiting on, and the session is reaped on its own clock
      // once it finishes.
      if (session.working) continue;
      if (session.replayTimer) clearTimeout(session.replayTimer);
      session.handle?.close();
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Agents the user has turned off.
   *
   * Checked before announcing, probing or warming: a disabled agent must not
   * appear in the drawer and must never be spawned. An installed agent nobody
   * uses still costs a process every time the app connects, because the app
   * asks each available agent what it supports.
   */
  private disabled = new Set<string>();

  /** Whether an agent may be announced, probed, or spawned. */
  private isEnabled(providerId: string): boolean {
    return !this.disabled.has(providerId);
  }

  private announceProviders() {
    const announce: wire.ProviderAnnounce = {
      t: "providers",
      machine: this.machine,
      providers: this.providers
        // Test fixtures are hidden unless explicitly asked for, so a demo or a
        // local run can still exercise the pipeline without any API keys.
        .filter((p) => !p.manifest.pew.experimental || this.includeExperimental)
        // Turned off by the user. Filtered here rather than in the app, so the
        // phone is never even told about an agent it should not offer.
        .filter((p) => this.isEnabled(p.manifest.id))
        // Not on this machine at all. Nothing about it can be acted on from a
        // phone \u2014 you cannot install a CLI from there \u2014 so a dimmed row for it
        // is a permanent piece of furniture that never becomes useful.
        //
        // This is also what makes the phone agree with `pew2 setup`: the picker
        // will not let these be chosen, so announcing them showed agents the
        // user was never offered. An agent that is installed but still needs a
        // key is a different case and stays, because it is really here and the
        // reason says what to do about it.
        .filter((p) => !p.commandMissing)
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
      // Which sessions this process actually holds. A client's list outlives
      // the daemon, so this is how it learns that an id it still shows died
      // with the previous process and must be resumed, not prompted.
      activeSessions: [...this.sessions.keys()],
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
    if (!session.live) return;
    if (!session.streamingReplay) {
      this.send(event);
      return;
    }
    (session.pendingReplay ??= []).push(event);
    // ACP can deliver a thousand notifications in one event-loop turn; a timer
    // cannot fire during that burst, so flush by size as well as by frame.
    if (session.pendingReplay.length >= REPLAY_BATCH_SIZE) {
      this.flushStreamingReplay(session, false);
      return;
    }
    if (!session.replayTimer) {
      session.replayTimer = setTimeout(() => this.flushStreamingReplay(session, false), 16);
      session.replayTimer.unref?.();
    }
  }

  private flushStreamingReplay(session: ActiveSession, complete: boolean) {
    if (session.replayTimer) clearTimeout(session.replayTimer);
    session.replayTimer = undefined;
    const events = session.pendingReplay?.splice(0) ?? [];
    if (events.length > 0 || complete) {
      this.send({ t: "session.replay", sessionId: session.log.sessionId, events, complete });
    }
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
    // The backlog goes out as one batched frame rather than hundreds: the app
    // folds it into a single render. An empty frame still matters because it
    // marks a resumed transcript as fully loaded and dismisses its skeleton.
    const backlog = session.log.since(-1);
    this.send({ t: "session.replay", sessionId, events: backlog });
  }

  /** Announce first, then reveal resume history in frame-sized batches. */
  markStreaming(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.live) return;
    session.live = true;
    session.streamingReplay = true;
    session.pendingReplay = session.log.since(-1);
    this.flushStreamingReplay(session, false);
  }

  finishStreaming(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.flushStreamingReplay(session, true);
    session.streamingReplay = false;
  }

  /**
   * The project a new session should open in, when the client named none.
   *
   * The agent's own most recent workspace, which is very likely the one the
   * user was last at their desk in. Without this a phone-started session lands
   * in the home directory: no project files, no project commands, and an agent
   * writing its state somewhere the user never chose.
   */
  async lastWorkspace(providerId: string): Promise<string | undefined> {
    // The probe is already resolved by the time a session starts, so this is a
    // map lookup in practice rather than a wait on the agent.
    const probed = await this.probes.get(providerId);
    return probed?.sessions[0]?.cwd ?? (await readProbeCache(providerId, this.env))?.sessions[0]?.cwd;
  }

  async startSession(providerId: string, cwd: string): Promise<string> {
    const provider = this.providers.find((p) => p.manifest.id === providerId);
    if (!provider) throw new Error(`Unknown provider '${providerId}'`);
    // Checked here too, not just where the list is announced. A phone that
    // connected before the agent was turned off still holds the old list, and
    // tapping one of those rows would otherwise spawn the very process that
    // turning it off was meant to prevent.
    if (!this.isEnabled(providerId)) {
      throw new Error(`'${provider.manifest.name}' is turned off on this machine.`);
    }
    if (!isAvailable(provider)) throw new Error(unavailableReason(provider)!);

    // Assign our own session id up front so events are attributable even if the
    // agent's own `session/new` is slow or fails.
    const log = new SessionLog(`${providerId}-${Date.now().toString(36)}`);
    // Registered before connecting so `record` has somewhere to hold events the
    // agent emits during the handshake itself.
    const session: ActiveSession = {
      handle: undefined,
      log,
      providerId,
      cwd,
      live: false,
      lastUsedAt: Date.now(),
      ready: Promise.resolve(),
    };
    this.sessions.set(log.sessionId, session);
    // Enforced as it opens, not on the reaper's five-minute tick: this is the
    // moment memory grows, and someone opening several conversations in a burst
    // would otherwise hold all of them until the next pass.
    this.enforceSessionCap(log.sessionId);

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

  /**
   * The agent's own id for a session, once it has opened one.
   *
   * Clients list the agent's stored conversations alongside their own, so a
   * session started here has to name itself in the agent's terms — otherwise
   * the next history probe lists the very conversation on screen a second time
   * as a stub, and reopening *that* copy loses the session's settings.
   */
  agentSessionId(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.agentSessionId;
  }

  /** Selectors (model, thinking level, mode) advertised by a session's agent. */
  configOptions(sessionId: string) {
    return this.sessions.get(sessionId)?.handle?.configOptions ?? [];
  }

  /**
   * Is this one of the projects this daemon announced for that agent?
   *
   * The gate on accepting a path from a client at all: it returns only strings
   * this process already published, so a caller cannot use it to ask whether
   * some other directory on the machine exists.
   */
  knownProject(providerId: string, cwd: string): string | undefined {
    const known = this.projectHistory.get(providerId);
    if (known?.some((session) => session.cwd === cwd)) return cwd;
    // A directory this daemon just offered in a `workspaces` answer counts for
    // the same reason: it published the string, so echoing it back reveals
    // nothing new. Without this a project reached by browsing is unknown until
    // its first session exists, and the composer would name the agent's
    // *previous* project while pointing at this one — which is worse than no
    // label, because it is confidently wrong.
    return this.offeredWorkspaces.has(cwd) ? cwd : undefined;
  }

  /**
   * Remember the directories just offered to a browsing client.
   *
   * Bounded, and not persisted: this is a short-lived echo check, not a record
   * of anything. Only the most recent listings need to be recognised, since a
   * path is chosen within seconds of being shown.
   */
  rememberOfferedWorkspaces(paths: string[]): void {
    for (const path of paths) {
      // Re-inserting moves it to the end of the Map's order, so a directory the
      // user keeps seeing is not the one evicted.
      this.offeredWorkspaces.delete(path);
      this.offeredWorkspaces.add(path);
    }
    while (this.offeredWorkspaces.size > 2_000) {
      const oldest = this.offeredWorkspaces.values().next().value;
      if (oldest === undefined) break;
      this.offeredWorkspaces.delete(oldest);
    }
  }

  /**
   * The agent's own conversations in one project, newest first.
   *
   * Counts are hydrated here rather than up front: doing every project at probe
   * time is hundreds of file reads for the one the user will actually pick.
   * Agents without a local index answer without counts, which the drawer omits.
   */
  async sessionsForProject(providerId: string, cwd: string): Promise<AgentSession[]> {
    const known = this.projectHistory.get(providerId);
    // No probe has landed yet. The app asked for capabilities first, so the
    // answer is on its way; an empty list here is corrected by that reply
    // rather than by a second spawn started from a menu tap.
    if (!known) return [];
    // Copied before hydrating: `hydrateMessageCounts` writes counts into the
    // objects it is given, and these are the cached list itself. Mutating them
    // would leave counts on rows the next probe overwrites wholesale.
    const picked = sessionsInProject(known, cwd, PROJECT_SESSION_LIMIT).map((s) => ({ ...s }));
    await hydrateMessageCounts(providerId, picked);
    return picked;
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
    // A disabled agent answers as if it has nothing, rather than spawning to
    // find out. The app should never ask \u2014 it is not announced \u2014 but a stale
    // client or a direct CLI call must not be able to boot it either.
    if (!this.isEnabled(providerId)) return EMPTY_CAPABILITIES;
    if (refresh) this.probes.delete(providerId);
    const cached = this.probes.get(providerId);
    if (cached) return cached;

    const provider = this.providers.find((p) => p.manifest.id === providerId);
    if (!provider || !isAvailable(provider)) return EMPTY_CAPABILITIES;

    // Armed here, while still synchronous with the call: everything below is
    // behind an await, and a tap landing in that window must find a promise to
    // wait on rather than spawning a second process next to this one.
    const { announce: announceSpare } = this.armSpare(providerId);

    // A spawn plus session/list is seconds per provider. Serve the last good
    // answer from disk instantly and refresh it in the background instead of
    // making the drawer wait on the agent's boot time.
    if (!refresh) {
      const disk = await readProbeCache(providerId, this.env);
      // Used whatever it holds. This used to insist every row carried a message
      // count and reprobe otherwise \u2014 which was reasonable while counts came
      // from opening each conversation, and became a trap the moment that
      // stopped: a count most agents never supply would have made the gate
      // permanently false, so the cache would never be used and every drawer
      // open would pay a full spawn.
      if (disk) {
        // Return disk history immediately while booting the matching provider.
        // The first tap can then adopt this process instead of starting cold.
        void this.warmProvider(providerId);
        // Survives a daemon restart, so the first project chosen after a reboot
        // is answered from disk rather than waiting on the background reprobe.
        if (disk.allSessions?.length) this.projectHistory.set(providerId, disk.allSessions);
        const served = Promise.resolve<ProviderCapabilities>({
          // Same correction as the live probe: the cache holds whatever the
          // agent reported when it was written, which predates any preference
          // chosen since.
          configOptions: withStoredPrefs(disk.configOptions, await readConfigPrefs(providerId)),
          sessions: disk.sessions,
          canResume: disk.canResume,
          // A cache from an older daemon has neither; the background refresh
          // below fills both in, and until then the app falls back to the
          // projects it can see in the history it holds.
          projects: disk.projects ?? [],
          // A cache written by an older daemon predates commands entirely; the
          // background refresh below fills them in.
          commands: disk.commands ?? [],
        });
        this.probes.set(providerId, served);
        return served;
      }
    }

    // `announceSpare` settles the moment the process answers, so a tap can
    // adopt it while the history probe below is still reading the disk. It only
    // ever resolves: a failed boot leaves no spare, which the caller already
    // handles by spawning cold, and rejecting would be an unhandled rejection
    // whenever nobody happened to be waiting.

    const probe = (async (): Promise<ProviderCapabilities> => {
      let handle: AcpSessionHandle | undefined;
      try {
        const workspace = resolveWorkspace();
        handle = await connectProvider({
          provider,
          // Same rule as session.start: under launchd cwd is `/`, which is not a
          // project directory. Probing from it hid every agent's sessions.
          cwd: workspace,
          // A probe session is never shown, so its output goes nowhere.
          onUpdate: () => {},
          onPermissionRequest: () => {},
        });
        const booted = handle;
        // Read once, before the awaits below, so the reply describes the same
        // settings the session this probe warms will actually open with.
        const storedPrefs = await readConfigPrefs(providerId);
        // Published before the history below, which is the slow half: listing
        // sessions and counting each one's messages is seconds of disk work,
        // and a new conversation needs none of it. Whoever adopts this calls
        // `session/new` on the same process; `listSessions` does not touch the
        // adopted session, so the two can safely overlap.
        this.stashSpare(providerId, booted, workspace);
        handle = undefined;
        announceSpare();

        // Needed several times below, and `listSessions` is the slow call:
        // once only.
        const { sessions, projects, all } = await booted.listSessions();
        // Held so choosing a project can be answered from memory. The agent was
        // already asked for every session it has; asking again per project
        // would pay the spawn and the list a second time for data this process
        // is already holding.
        this.projectHistory.set(providerId, all);

        const capabilities: ProviderCapabilities = {
          // The user's remembered choices, not the agent's defaults. The probe
          // session is a throwaway that never had preferences applied, so
          // reporting its own values showed "Default" in the pills right up
          // until the first prompt created a real session and corrected them.
          configOptions: withStoredPrefs(booted.configOptions, storedPrefs),
          // The agent's own history, including everything started at the desk.
          sessions,
          canResume: booted.canLoadSession,
          // The complete set of places this agent has worked, which the capped
          // `sessions` above cannot describe.
          projects,
          // Read after `listSessions` deliberately. Commands arrive as a
          // notification rather than in `session/new`'s result, so reading them
          // the instant the session opened would find none; that round trip is
          // the window they land in.
          //
          // Falling back to the project's own files when the agent sent none:
          // some agents ship no such notification at all, and their commands
          // would otherwise be invisible. The agent always wins when it does
          // answer, since only it knows its built-ins.
          commands: booted.availableCommands.length
            ? booted.availableCommands
            : await readCommandDirs(
                provider.manifest.pew.commandDirs,
                // The agent's own most recent project, not the daemon's cwd.
                // Under launchd that cwd is `/` and `resolveWorkspace()` falls
                // back to home, which holds no project's commands — so the
                // fallback would find nothing for every agent that needs it.
                sessions[0]?.cwd ?? workspace,
              ),
        };
        // Persist so the next ask — and the next daemon boot — answers from
        // disk instead of spawning again.
        void writeProbeCache(providerId, capabilities, this.env, all).catch(() => {});
        return capabilities;
      } catch (error) {
        // A probe is best-effort: this is what the app shows before a session
        // exists, and failing here must not stop the user starting a real one.
        console.error(`[${providerId}] capability probe failed:`, error);
        this.probes.delete(providerId);
        // Releases anyone waiting on the boot. Harmless once already announced.
        announceSpare();
        return EMPTY_CAPABILITIES;
      } finally {
        handle?.close();
      }
    })();

    this.probes.set(providerId, probe);
    return probe;
  }

  /** Begin restoring immediately; callers can announce before the agent is ready. */
  beginResumeSession(providerId: string, agentSessionId: string, cwd: string) {
    const provider = this.providers.find((p) => p.manifest.id === providerId);
    if (!provider) throw new Error(`Unknown provider '${providerId}'`);
    // Checked here too, not just where the list is announced. A phone that
    // connected before the agent was turned off still holds the old list, and
    // tapping one of those rows would otherwise spawn the very process that
    // turning it off was meant to prevent.
    if (!this.isEnabled(providerId)) {
      throw new Error(`'${provider.manifest.name}' is turned off on this machine.`);
    }
    if (!isAvailable(provider)) throw new Error(unavailableReason(provider)!);

    const log = new SessionLog(`${providerId}-${Date.now().toString(36)}`);
    const session: ActiveSession = {
      handle: undefined,
      log,
      providerId,
      cwd,
      live: false,
      lastUsedAt: Date.now(),
      ready: Promise.resolve(),
    };
    this.sessions.set(log.sessionId, session);
    // Enforced as it opens, not on the reaper's five-minute tick: this is the
    // moment memory grows, and someone opening several conversations in a burst
    // would otherwise hold all of them until the next pass.
    this.enforceSessionCap(log.sessionId);
    session.ready = this.connectSession(session, provider, cwd, agentSessionId);
    return { sessionId: log.sessionId, ready: session.ready };
  }

  async resumeSession(providerId: string, agentSessionId: string, cwd: string) {
    const pending = this.beginResumeSession(providerId, agentSessionId, cwd);
    try {
      await pending.ready;
      return pending.sessionId;
    } catch (error) {
      this.sessions.delete(pending.sessionId);
      throw error;
    }
  }

  /**
   * Record a choice made before any session exists.
   *
   * The empty state offers the same selectors a live conversation does, but a
   * session is only created by the first prompt — so there is nothing to set
   * the option on yet. Storing it here is what makes the pill stick: the
   * session that prompt creates applies it on connect.
   */
  async rememberConfigOption(providerId: string, configId: string, value: string | boolean) {
    await writeConfigPref(providerId, configId, value);
  }

  async setConfigOption(sessionId: string, configId: string, value: string | boolean) {
    const session = this.require(sessionId);
    await session.ready;
    const updated = await session.handle!.setConfigOption(configId, value);
    // Only after the agent accepted it: remembering a rejected choice would
    // reapply a broken setting to every session that follows.
    void writeConfigPref(session.providerId, configId, value).catch(() => {});
    // ...and against this conversation, so reopening it restores the choice
    // rather than the agent's default. Both: the provider record seeds the next
    // new session, this one survives leaving and coming back.
    // Only when the agent named the conversation: without an id there is
    // nothing to key the record by, and a placeholder would hand its selectors
    // to the next session that also lacks one.
    const agentSessionId = session.agentSessionId;
    if (agentSessionId) {
      void writeSessionPrefs(session.providerId, agentSessionId, { [configId]: value }).catch(
        () => {},
      );
    }
    return updated;
  }

  async prompt(sessionId: string, text: string, attachments: wire.PromptAttachment[] = []) {
    const session = this.require(sessionId);
    // Use, and the start of a turn. `working` is cleared in the `finally` below
    // rather than on the agent's last word: an agent can go quiet for minutes
    // mid-tool, and a reaper that read silence as "done" would close the
    // process out from under a turn the user is waiting on.
    //
    // The whole body is inside the try, including storing attachments. A throw
    // before the flag was cleared would leave the session marked working for
    // ever, and a permanently working session is one the reaper can never
    // touch — the exact leak this flag exists to bound.
    session.lastUsedAt = Date.now();
    session.working = true;
    try {
      // Written before the echo: an attachment that cannot be stored (over the
      // limits, disk full) must fail the whole prompt rather than leave a turn on
      // every screen referring to a file the agent never got.
      const stored = await storeAttachments(sessionId, attachments);
      // Echo immediately, then queue against a still-loading agent if necessary.
      // The paths ride along so every client — including one replaying later —
      // can show what was sent; only this machine can read them, which is exactly
      // what `image.fetch` already exists to handle.
      this.send(
        session.log.append({
          kind: "user_message",
          text,
          // Omitted entirely when there are none, so the shape of an ordinary
          // text turn — which is nearly all of them — is unchanged in the log and
          // in every replayed frame.
          ...(stored.length > 0 && {
            attachments: stored.map((file) => ({
              name: file.name,
              mimeType: file.mimeType,
              uri: file.path,
            })),
          }),
        }),
      );
      await session.ready;
      await session.handle!.prompt(text, stored);
    } finally {
      session.working = false;
      // Touched again at the end, so the idle window is measured from when the
      // agent stopped rather than from when the user typed. A turn that ran for
      // twenty minutes would otherwise be reapable the moment it finished.
      session.lastUsedAt = Date.now();
    }
  }

  async cancel(sessionId: string) {
    const session = this.require(sessionId);
    await session.ready;
    await session.handle!.cancel();
  }

  answerPermission(sessionId: string, requestId: string, optionId: string) {
    return this.require(sessionId).handle?.answerPermission(requestId, optionId) ?? false;
  }

  /**
   * Where this session's agent is running, for resolving the relative paths it
   * uses to name files. Undefined once the session is gone, in which case the
   * caller falls back to the daemon's own workspace.
   */
  sessionCwd(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.cwd;
  }

  /**
   * Who ran this session and in which project, for the "agent finished"
   * notification.
   *
   * Only this machine has the path, and the phone must be able to name the
   * work even for a session it is not currently showing — which is exactly the
   * case a notification exists for.
   */
  sessionOrigin(sessionId: string): { providerId?: string; folder?: string } {
    const session = this.sessions.get(sessionId);
    if (!session) return {};
    return { providerId: session.providerId, folder: folderName(session.cwd) };
  }

  /** Replay everything a reconnecting client has not seen yet. */
  replay(sessionId: string, cursor: number): wire.SessionEvent[] {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    // Reading a conversation is using it. Without this, a session someone is
    // sitting in — scrolling, reading a long answer — aged out on the same
    // clock as one nobody had opened since breakfast.
    session.lastUsedAt = Date.now();
    return session.log.since(cursor);
  }

  closeAll() {
    if (this.reaper) {
      clearInterval(this.reaper);
      this.reaper = undefined;
    }
    for (const session of this.sessions.values()) {
      if (session.replayTimer) clearTimeout(session.replayTimer);
      session.handle?.close();
      // The files were only ever a delivery mechanism for the agent that is
      // now gone. Best effort, and in the tempdir either way.
      void discardAttachments(session.log.sessionId);
    }
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
