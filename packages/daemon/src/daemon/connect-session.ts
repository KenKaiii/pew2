/**
 * Attaching a session to its agent process: warm spare or cold spawn, local
 * history paint, the ACP callbacks, and re-applying stored selectors.
 */
import type { LoadedProvider } from "../providers/registry.js";
import { connectProvider, type ConfigOption } from "../acp/connect.js";
import { loadClaudeDisplayHistory } from "../acp/claude-history.js";
import { loadGgCoderDisplayHistory } from "../acp/ggcoder-history.js";
import { readConfigPrefs, type ConfigPrefs } from "../config-prefs.js";
import { readSessionPrefs, writeSessionPrefs } from "../session-prefs.js";
import { readCommandDirs } from "../commands/from-disk.js";
import { DaemonPromptQueue } from "./prompt-queue.js";
import { GG_GOALS_ID, type ActiveSession, type SessionCallbacks } from "./types.js";

export abstract class DaemonConnectSession extends DaemonPromptQueue {
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
  protected async announceDiskCommands(
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
  protected publishConfigOptions(session: ActiveSession, configOptions: ConfigOption[]) {
    if (!session.live) return;
    this.send({
      t: "session.config",
      sessionId: session.log.sessionId,
      providerId: session.providerId,
      configOptions,
    });
  }

  /**
   * Everything the agent's process reports for this session, routed into it.
   *
   * Shared by the first connect and `resetContext`, so a fresh context on the
   * same process records, notifies and publishes exactly as the first one did.
   */
  protected sessionCallbacks(session: ActiveSession): SessionCallbacks {
    return {
      onUpdate: (payload: unknown) => this.record(session, payload),
      onPermissionRequest: ({ requestId, params }: { requestId: string; params: unknown }) => {
        // Held before the event goes out, for the same reason the resolver is
        // registered before the UI is notified: an answer can come back on the
        // very next frame, and it must find this here to remove.
        (session.permissions ??= new Map()).set(requestId, params);
        // The blocked clock starts at the question, not at the last thing the
        // user did: `reapIdleSessions` measures the wait from here, and without
        // this stamp a request raised late in a busy session would be measured
        // from before it was even asked.
        session.lastUsedAt = Date.now();
        this.record(session, { kind: "permission_request", requestId, params });
        // Out of band too: nothing times a permission out, so a phone in a
        // pocket is the difference between the agent waiting a minute and
        // waiting until the reaper closes it an hour later. After `record`, so
        // the badge this carries already counts this request.
        const tool = (params as { toolCall?: { title?: unknown } } | null)?.toolCall?.title;
        this.notifyPhones(
          session.log.sessionId,
          "approval",
          typeof tool === "string" ? tool : undefined,
        );
      },
      gg: {
        // Same order as a permission: held, clock stamped, then told.
        onAskUser: ({ requestId, params }: { requestId: string; params: unknown }) => {
          const raw = (params as { questions?: unknown } | null)?.questions;
          const questions = Array.isArray(raw) ? raw : [];
          (session.asks ??= new Map()).set(requestId, questions);
          session.lastUsedAt = Date.now();
          this.record(session, { kind: "ask_user", requestId, questions });
          // Same reason as a permission: the agent is stopped on this.
          const first = (questions[0] as { question?: unknown } | undefined)?.question;
          this.notifyPhones(
            session.log.sessionId,
            "question",
            typeof first === "string" ? first : undefined,
          );
        },
        // The agent withdrew it (JSON-RPC cancel, or a new ask superseded it).
        onAskClosed: (requestId: string) => this.closeAsk(session, requestId),
        onQueueUpdate: (params: unknown) => this.applyAgentQueueUpdate(session, params),
        onGoalState: (params: unknown) => this.applyGoalState(session, params),
        onPlanState: (params: unknown) => {
          if (session.providerId !== GG_GOALS_ID) this.applyPlanState(session, params);
        },
        onSessionReset: (params: unknown) => this.applySessionReset(session, params),
        onAutopilotState: (params: unknown) => {
          if (session.providerId !== GG_GOALS_ID) this.applyAutopilotState(session, params);
        },
        onAutopilotEvent: (params: unknown) => {
          if (session.providerId !== GG_GOALS_ID) this.applyAutopilotEvent(session, params);
        },
        onChecklistChanged: () => {
          if (session.live && session.providerId !== GG_GOALS_ID)
            this.send({ t: "checklist", sessionId: session.log.sessionId, changed: true });
        },
      },
      onConfigOptions: (configOptions: ConfigOption[]) =>
        this.publishConfigOptions(session, configOptions),
      onExit: (code: number | null) => this.record(session, { kind: "exit", code }),
    };
  }

  /**
   * Connect a session to its agent, warm when possible.
   *
   * A dead spare (the process exited while idle) falls back to a cold spawn
   * rather than failing the open.
   */
  protected async connectSession(
    session: ActiveSession,
    provider: LoadedProvider,
    cwd: string,
    loadSessionId: string | undefined,
  ): Promise<void> {
    const callbacks = this.sessionCallbacks(session);

    // Paint local JSONL history immediately for providers whose ACP load path
    // scans or initializes before replay. Suppress only that duplicate history;
    // the attached agent remains authoritative for config and all live updates.
    const localUpdates = loadSessionId
      ? provider.manifest.id === "claude-code"
        ? (await loadClaudeDisplayHistory(loadSessionId, cwd))?.map((message) => ({
            sessionUpdate:
              message.role === "user"
                ? "user_message_chunk"
                : message.role === "thought"
                  ? "agent_thought_chunk"
                  : "agent_message_chunk",
            // An array only when there are pictures to carry: the single block
            // is the shape every other replay path emits.
            content:
              message.images.length > 0
                ? [{ type: "text", text: message.text }, ...message.images]
                : { type: "text", text: message.text },
          }))
        : provider.manifest.id === "ggcoder"
          ? await loadGgCoderDisplayHistory(loadSessionId, cwd)
          : // A past replay is only a snapshot: it misses later turns, including
            // work done at the desktop. Without a current native history file,
            // let the agent replay rather than suppressing it for stale cache.
            undefined
      : undefined;
    if (localUpdates) {
      for (const update of localUpdates) {
        // GG Coder's persisted Ken verdicts arrive in order among the turns and
        // are logged as the same event the live Autopilot cycle produces —
        // history, so no push.
        if ((update as { kind?: unknown }).kind === "autopilot") this.record(session, update);
        else callbacks.onUpdate({ sessionId: loadSessionId, update });
      }
    }
    // Already on screen, so the agent does not need to send it again. Agents
    // that offer `session/resume` are asked to restore context without the
    // replay; the rest still replay and it is still discarded below.
    const haveHistory = localUpdates !== undefined;
    let loadingDuplicateReplay = haveHistory;
    const agentCallbacks = {
      ...callbacks,
      onUpdate: (payload: unknown) => {
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
    this.noteExtensions(provider.manifest.id, session.handle);
    loadingDuplicateReplay = false;
    // The agent's own id for the conversation, which is what the per-session
    // selectors below are keyed by and what the app dedupes history against.
    session.agentSessionId = session.handle.sessionId;
    // A goal's coordinator: seed its state so a catch-up has something before
    // the first `_gg/goal_state` arrives.
    const goalMeta = session.handle.goal;
    if (goalMeta && !session.goal) {
      session.goal = {
        t: "goal.state",
        sessionId: session.log.sessionId,
        goalId: goalMeta.id,
        phase: goalMeta.phase === "active" ? "active" : "briefing",
        paused: goalMeta.paused === true,
        workers: [],
      };
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
  protected async applyConfigPrefs(
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
  protected async applySessionPrefs(
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
  protected async applyPrefs(
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
      const offered = !option.options || option.options.some((choice) => choice.value === value);
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
}
