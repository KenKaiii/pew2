/**
 * GG Coder's ACP extensions: plan review, Autopilot, the project checklist,
 * goal state, and the goals themselves (`_gg/goals/*`, `_gg/goal/*`), plus the
 * project task list, which GG Coder keeps only on disk.
 */
import { isAvailable, unavailableReason, type LoadedProvider } from "../providers/registry.js";
import { connectProvider, type AcpSessionHandle, type ConfigOption } from "../acp/connect.js";
import type { ConfigPrefs } from "../config-prefs.js";
import { readSessionPrefs, writeSessionPrefs } from "../session-prefs.js";
import { homedir } from "node:os";
import { join, resolve as __resolve } from "node:path";
import { resolveWorkspace } from "../workspace.js";
import { readTasks, runPromptFor, toTaskRow } from "../gg-tasks.js";
import { wire } from "@pew2/protocol";
import { DaemonProjects } from "./projects.js";
import {
  AUTOPILOT_PHASES,
  GG_GOALS_ID,
  GG_PROVIDER_ID,
  type ActiveSession,
  type SessionCallbacks,
  type TaskRun,
} from "./types.js";

export abstract class DaemonGg extends DaemonProjects {
  /** Where GG Coder keeps per-project task lists; a field so tests can point it elsewhere. */
  protected ggTasksBase = join(homedir(), ".gg-tasks", "projects");

  protected abstract sessionCallbacks(session: ActiveSession): SessionCallbacks;
  protected abstract applyPrefs(
    session: ActiveSession,
    providerId: string,
    prefs: ConfigPrefs,
  ): Promise<ConfigPrefs>;
  protected abstract publishConfigOptions(
    session: ActiveSession,
    configOptions: ConfigOption[],
  ): void;
  protected abstract announceDiskCommands(
    session: ActiveSession,
    provider: LoadedProvider,
    cwd: string,
  ): Promise<void>;

  /**
   * Give a session a fresh agent context on the process it already has, as
   * GG Coder's own task runner does with `newSession()`.
   *
   * A second `session/new` on a running GG Coder disposes the old session and
   * opens a new on-disk one, so the conversation keeps its pew2 id while the
   * agent forgets everything before it. Returns the new agent session id.
   */
  protected async resetContext(session: ActiveSession): Promise<string> {
    await session.ready;
    const handle = session.handle;
    if (!handle) throw new Error("The agent isn't connected.");
    const previous = session.agentSessionId;
    // A new session comes back on the agent's defaults; the chat keeps what it was running.
    const selectors: ConfigPrefs = Object.fromEntries(
      handle.configOptions.map((option) => [option.id, option.currentValue]),
    );
    await handle.adopt({ cwd: session.cwd, ...this.sessionCallbacks(session) });
    session.agentSessionId = handle.sessionId;
    // A plan pending in the old context can no longer be decided.
    if (session.plan) this.applyPlanState(session, { planMode: false, pending: null });
    await this.applyPrefs(session, session.providerId, selectors);
    this.publishConfigOptions(session, handle.configOptions);
    const provider = this.providers.find((p) => p.manifest.id === session.providerId);
    if (provider) await this.announceDiskCommands(session, provider, session.cwd);
    if (previous) {
      void readSessionPrefs(session.providerId, previous)
        .then((prefs) => writeSessionPrefs(session.providerId, handle.sessionId, prefs))
        .catch(() => {});
    }
    return handle.sessionId;
  }

  /** `_gg/plan_state`: the plan sheet's state, broadcast and kept for catch-up. */
  protected applyPlanState(session: ActiveSession, params: unknown) {
    const raw = params as { planMode?: unknown; pending?: unknown } | null;
    const parsed = wire.PlanState.safeParse({
      t: "plan.state",
      sessionId: session.log.sessionId,
      planMode: raw?.planMode === true,
      pending: raw?.pending ?? null,
    });
    if (!parsed.success) return;
    session.plan = parsed.data;
    this.touchInbox();
    if (session.live) this.send(parsed.data);
  }

  /** `_gg/session_reset`: an accepted plan moved the agent to a fresh on-disk session. */
  protected applySessionReset(session: ActiveSession, params: unknown) {
    const raw = params as { agentSessionId?: unknown; planTotal?: unknown } | null;
    // Resume must reopen the NEW conversation, which holds the implementation.
    if (typeof raw?.agentSessionId === "string" && raw.agentSessionId) {
      session.agentSessionId = raw.agentSessionId;
    }
    this.record(session, {
      kind: "plan_accepted",
      ...(typeof raw?.planTotal === "number" ? { planTotal: raw.planTotal } : {}),
      // So the app's row reopens the implementation after a daemon restart too.
      ...(typeof raw?.agentSessionId === "string" && raw.agentSessionId
        ? { agentSessionId: raw.agentSessionId }
        : {}),
    });
  }

  /** `_gg/autopilot_state`: whether Ken is on / reviewing; live state, never logged. */
  protected applyAutopilotState(session: ActiveSession, params: unknown) {
    const raw = params as { enabled?: unknown; reviewing?: unknown } | null;
    const state: wire.AutopilotState = {
      t: "autopilot.state",
      sessionId: session.log.sessionId,
      enabled: raw?.enabled === true,
      reviewing: raw?.reviewing === true,
    };
    session.autopilot = state;
    if (session.live) this.send(state);
  }

  /** `_gg/autopilot_event`: one of Ken's verdicts, logged; `human`/`capped` also push. */
  protected applyAutopilotEvent(session: ActiveSession, params: unknown) {
    const raw = params as {
      phase?: unknown;
      reason?: unknown;
      body?: unknown;
      round?: unknown;
    } | null;
    if (typeof raw?.phase !== "string" || !AUTOPILOT_PHASES.has(raw.phase)) return;
    session.lastUsedAt = Date.now();
    this.record(session, {
      kind: "autopilot",
      phase: raw.phase,
      ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
      ...(typeof raw.body === "string" ? { body: raw.body } : {}),
      ...(typeof raw.round === "number" ? { round: raw.round } : {}),
    });
    if (
      (raw.phase === "human" || raw.phase === "capped") &&
      (params as { history?: unknown }).history !== true
    ) {
      const sessionId = session.log.sessionId;
      const reason = typeof raw.reason === "string" && raw.reason ? `: ${raw.reason}` : "";
      this.notifyPhones(sessionId, "finished", `Ken needs you${reason}`);
    }
  }

  /** `autopilot.set`: turn Ken on or off for this session's project. */
  async setAutopilot(sessionId: string, enabled: boolean): Promise<void> {
    const session = this.require(sessionId);
    if (session.providerId === GG_GOALS_ID)
      throw new Error("Autopilot is for GG Coder conversations.");
    await session.ready;
    if (!session.handle?.ggCapabilities?.autopilot) throw new Error("This agent has no Autopilot.");
    await session.handle.extRequest("_gg/autopilot/set", {
      sessionId: session.handle.sessionId,
      enabled,
    });
  }

  /** `checklist`: the project checklist via `_gg/checklist`, mapped to wire rows. */
  async checklist(
    sessionId: string,
  ): Promise<{ staleAfterDays?: number; items: wire.ChecklistItemRow[] }> {
    const session = this.require(sessionId);
    if (session.providerId === GG_GOALS_ID)
      throw new Error("The checklist is for GG Coder conversations.");
    await session.ready;
    if (!session.handle?.ggCapabilities?.checklist)
      throw new Error("This agent has no project checklist.");
    const raw = await session.handle.extRequest<{ staleAfterDays?: unknown; items?: unknown }>(
      "_gg/checklist",
      { sessionId: session.handle.sessionId },
    );
    const items = (Array.isArray(raw?.items) ? raw.items : []).flatMap((item) => {
      const parsed = wire.ChecklistItemRow.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    });
    return {
      ...(typeof raw?.staleAfterDays === "number" ? { staleAfterDays: raw.staleAfterDays } : {}),
      items,
    };
  }

  /** The GG Coder session a task request is about, or why there is none. */
  private taskSession(sessionId: string): ActiveSession {
    const session = this.require(sessionId);
    if (session.providerId !== GG_PROVIDER_ID)
      throw new Error("Tasks are for GG Coder conversations.");
    return session;
  }

  /** `tasks`: the session's project task list, read from GG Coder's file. */
  async tasks(sessionId: string): Promise<wire.TaskRow[]> {
    const session = this.taskSession(sessionId);
    return (await readTasks(this.ggTasksBase, session.cwd)).map(toTaskRow);
  }

  /**
   * `task.start`: check a task can run in this conversation now.
   *
   * Nothing is written here: `prompt` resets the context and marks the task in
   * progress as the turn starts. The list comes back as it will be once it has.
   */
  async claimTask(
    sessionId: string,
    taskId: string,
  ): Promise<{ run: TaskRun; items: wire.TaskRow[] }> {
    const session = this.taskSession(sessionId);
    const busy = "The agent is still working; run the task when it stops.";
    if (session.working) throw new Error(busy);
    const tasks = await readTasks(this.ggTasksBase, session.cwd);
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error("That task no longer exists.");
    const prompt = runPromptFor(task);
    if (prompt === null) {
      throw new Error(
        task.status === "done" ? "That task is already done." : "That task is already running.",
      );
    }
    // Again after the read: a prompt may have started while the file was open.
    if (session.working) throw new Error(busy);
    return {
      run: { id: task.id, title: task.title, prompt },
      items: tasks.map((t) => toTaskRow(t.id === task.id ? { ...t, status: "in-progress" } : t)),
    };
  }

  /** `_gg/goal_state`: the goal's live phase and workers, broadcast and kept for catch-up. */
  protected applyGoalState(session: ActiveSession, params: unknown) {
    const raw = params as {
      goalId?: unknown;
      phase?: unknown;
      paused?: unknown;
      critterModel?: unknown;
      workers?: unknown;
    } | null;
    if (typeof raw?.goalId !== "string") return;
    const workers = (Array.isArray(raw.workers) ? raw.workers : []).flatMap((worker) => {
      const parsed = wire.GoalWorker.safeParse(worker);
      return parsed.success ? [parsed.data] : [];
    });
    const state: wire.GoalState = {
      t: "goal.state",
      sessionId: session.log.sessionId,
      goalId: raw.goalId,
      phase: raw.phase === "active" ? "active" : "briefing",
      paused: raw.paused === true,
      workers,
      ...(typeof raw.critterModel === "string" || raw.critterModel === null
        ? { critterModel: raw.critterModel }
        : {}),
    };
    session.goal = state;
    if (session.live) this.send(state);
  }

  /**
   * Whether this session just opened on a goal that still needs its kickoff
   * turn, claiming it so it can only ever be started once.
   */
  claimKickoff(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session?.handle?.goal?.needsKickoff || session.kickedOff) return false;
    session.kickedOff = true;
    return true;
  }

  // ── Goals (GG Coder) ───────────────────────────────────────

  /**
   * A GG Coder connection that speaks the goals extension.
   *
   * Any process will do — goals live on disk, not in a session — so a live
   * ggcoder session or a warm spare is used first, and only otherwise one is
   * booted (and parked as the spare, so it is reused and idles out).
   */
  protected async goalsConnection(): Promise<AcpSessionHandle> {
    const provider = this.providers.find((p) => p.manifest.id === GG_PROVIDER_ID);
    if (!provider || provider.commandMissing) {
      throw new Error("GG Coder isn't installed on this machine.");
    }
    if (!this.isEnabled(GG_PROVIDER_ID)) throw new Error("GG Coder is turned off on this machine.");
    if (!isAvailable(provider))
      throw new Error(unavailableReason(provider) ?? "GG Coder is unavailable.");
    const supports = (handle: AcpSessionHandle) => {
      if (!handle.ggCapabilities?.goals) {
        throw new Error("This GG Coder is too old for goals. Update it on your computer.");
      }
      return handle;
    };
    // An exited process still has a handle. A crash, a kill, or a `ggcoder`
    // linked to a checkout whose build had just wiped `dist/` all leave one
    // behind, and handing it out failed every goals request with "ACP
    // connection closed" until the reaper or the spare TTL happened to clear it.
    const alive = (handle: AcpSessionHandle) =>
      handle.child.exitCode === null && handle.child.signalCode === null;
    for (const [key, spare] of this.spares) {
      if (alive(spare.handle)) continue;
      clearTimeout(spare.timer);
      spare.handle.close();
      this.spares.delete(key);
    }
    const live = [...this.sessions.values()]
      .filter(
        (s) =>
          (s.providerId === GG_PROVIDER_ID || s.providerId === GG_GOALS_ID) &&
          s.handle &&
          s.agentSessionId &&
          alive(s.handle),
      )
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0]?.handle;
    if (live) return supports(live);
    const spare = [...this.spares.values()].find(
      (s) => s.providerId === GG_PROVIDER_ID || s.providerId === GG_GOALS_ID,
    );
    if (spare) return supports(spare.handle);
    // A capability probe already booting GG Coder will park its process as a
    // spare. Wait for that rather than racing it with a second boot: two boots
    // land on the same spare key, and whichever is stashed second closes the
    // first — mid-`session/list` for the probe, which then failed with "ACP
    // connection closed" and left GG Coder's chats and goals list empty.
    const warming = this.warming.get(GG_PROVIDER_ID);
    if (warming) {
      await warming.catch(() => {});
      const parked = [...this.spares.values()].find((s) => s.providerId === GG_PROVIDER_ID);
      if (parked) return supports(parked.handle);
    }
    this.ggConnecting ??= (async () => {
      const workspace = resolveWorkspace();
      const handle = await connectProvider({
        provider,
        cwd: workspace,
        onUpdate: () => {},
        onPermissionRequest: () => {},
      });
      // Never evict a parked process for this one: a probe may still be using
      // it. If one appeared while this booted, keep it and drop the newcomer.
      const parked = [...this.spares.values()].find((s) => s.providerId === GG_PROVIDER_ID);
      if (parked) {
        handle.close();
        return parked.handle;
      }
      this.stashSpare(GG_PROVIDER_ID, handle, workspace);
      return handle;
    })().finally(() => {
      this.ggConnecting = undefined;
    });
    return supports(await this.ggConnecting);
  }

  /** Read one goal summary off GG Coder, dropping anything malformed. */
  protected static readGoal(value: unknown): wire.GoalSummary | undefined {
    // GG Coder sends `null` for a field it has no value for yet: a goal created
    // a moment ago has no coordinator conversation, so `agentSessionId` is null.
    // The wire treats absent as "none", so nulls are dropped before parsing.
    // Rejecting them threw away every new goal ("GG Coder did not return the
    // new goal"), while goals that had run once listed fine.
    if (value && typeof value === "object") {
      value = Object.fromEntries(Object.entries(value).filter(([, v]) => v !== null));
    }
    const parsed = wire.GoalSummary.safeParse(value);
    if (!parsed.success) {
      console.error("[ggcoder] ignoring a malformed goal:", parsed.error.issues[0]?.message);
      return undefined;
    }
    return parsed.data;
  }

  /** The live daemon session open on a goal folder, newest use first. */
  protected goalSessionEntry(path: string): [string, ActiveSession] | undefined {
    return [...this.sessions.entries()]
      .filter(
        ([, s]) =>
          (s.providerId === GG_PROVIDER_ID || s.providerId === GG_GOALS_ID) && s.cwd === path,
      )
      .sort((a, b) => b[1].lastUsedAt - a[1].lastUsedAt)[0];
  }

  /** GG Coder never reports `running` or a daemon session: only this process knows. */
  protected overlayGoal(goal: wire.GoalSummary): wire.GoalSummary {
    const { sessionId: _ignored, ...rest } = goal;
    const live = this.goalSessionEntry(goal.path);
    if (!live) return rest;
    return {
      ...rest,
      sessionId: live[0],
      ...(live[1].working ? { status: "running" as const } : {}),
    };
  }

  /**
   * Every goal on this machine, overlaid with live state.
   *
   * Listing a goal publishes its folder, so each becomes a known project: the
   * app opens a goal by starting a ggcoder session with that folder as `cwd`.
   */
  async listGoals(): Promise<wire.GoalSummary[]> {
    const answer = await this.onBorrowed(await this.goalsConnection(), (handle) =>
      handle.extRequest<{ goals?: unknown }>("_gg/goals/list", {}),
    );
    const goals = (Array.isArray(answer?.goals) ? answer.goals : []).flatMap((value) => {
      const goal = DaemonGg.readGoal(value);
      return goal ? [goal] : [];
    });
    this.goalNames = new Map(goals.map((g) => [__resolve(g.path), g.name]));
    for (const goal of goals) await this.rememberProject(goal.path);
    return goals.map((goal) => this.overlayGoal(goal));
  }

  async createGoal(input: {
    name: string;
    goal: string;
    context: string[];
    instructions?: string;
  }): Promise<wire.GoalSummary> {
    const answer = await this.onBorrowed(await this.goalsConnection(), (handle) =>
      handle.extRequest<{ goal?: unknown }>("_gg/goals/create", {
        name: input.name,
        goal: input.goal,
        context: input.context,
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      }),
    );
    const goal = DaemonGg.readGoal(answer?.goal);
    if (!goal) throw new Error("GG Coder did not return the new goal.");
    this.goalNames.set(__resolve(goal.path), goal.name);
    await this.rememberProject(goal.path);
    return this.overlayGoal(goal);
  }

  /** One goal by id, with the daemon session open on it, if any. */
  async findGoal(goalId: string): Promise<wire.GoalSummary> {
    const goal = (await this.listGoals()).find((g) => g.id === goalId);
    if (!goal) throw new Error("That goal no longer exists.");
    return goal;
  }

  /** The open session on a goal, for the session-scoped `_gg/goal/*` calls. */
  protected openGoalSession(goal: wire.GoalSummary): { sessionId: string; session: ActiveSession } {
    const session = goal.sessionId ? this.sessions.get(goal.sessionId) : undefined;
    if (!goal.sessionId || !session?.handle) throw new Error("Open the goal first.");
    return { sessionId: goal.sessionId, session };
  }

  /**
   * `delete`, `pause`, `update` and `critterModel`. `resume` needs a session
   * opened through the transport's start/resume flow, so the handler owns it.
   */
  async goalAction(
    goalId: string,
    action: "delete" | "pause" | "update" | "critterModel",
    input: { context?: string[]; instructions?: string; model?: string | null } = {},
  ): Promise<wire.GoalSummary | undefined> {
    const goal = await this.findGoal(goalId);
    if (action === "delete") {
      const live = this.goalSessionEntry(goal.path);
      if (live?.[1].working) throw new Error("GG Goals is working on this goal. Pause it first.");
      await this.onBorrowed(await this.goalsConnection(), (handle) =>
        handle.extRequest("_gg/goals/delete", { id: goalId }),
      );
      return undefined;
    }
    const { sessionId, session } = this.openGoalSession(goal);
    const handle = session.handle!;
    await session.ready;
    if (action === "pause") {
      await handle.extRequest("_gg/goal/pause", { sessionId: handle.sessionId });
      if (session.working) await this.cancel(sessionId);
    } else if (action === "update") {
      await handle.extRequest("_gg/goal/update", {
        sessionId: handle.sessionId,
        ...(input.context !== undefined ? { context: input.context } : {}),
        ...(input.instructions !== undefined ? { instructions: input.instructions } : {}),
      });
    } else {
      await handle.extRequest("_gg/goal/critter_model", {
        sessionId: handle.sessionId,
        model: input.model ?? null,
      });
    }
    return (await this.listGoals()).find((g) => g.id === goalId);
  }
}
