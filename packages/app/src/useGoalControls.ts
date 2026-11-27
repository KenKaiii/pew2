/**
 * GG Coder and GG Goals on the main screen: the queue, ask_user, plan review,
 * autopilot, the checklist, the task list, and the goal actions and their sheets.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from "react";
import type { useDaemon } from "./useDaemon";
import { ggStrips, isGoalsProvider } from "./goalsAgent";
import { goalForSession, type GoalSummary } from "./ggState";
import { latestKenSaying, withoutKenLines } from "./kenLine";
import { returnedDraft } from "./queue";
import type { AskResult } from "./askUser";
import type { ComposerDockHandle } from "./ui/ComposerDock";
import { haptics } from "./ui/haptics";

export function useGoalControls({
  daemon,
  activeId,
  composer,
  devSheet,
  setMenuOpen,
  launchingGoal,
  setLaunchingGoal,
  setNewGoalPrefill,
  setNewGoalOpen,
}: {
  daemon: ReturnType<typeof useDaemon>;
  activeId: string | undefined;
  composer: RefObject<ComposerDockHandle | null>;
  devSheet: string | undefined;
  setMenuOpen: Dispatch<SetStateAction<boolean>>;
  launchingGoal: string | undefined;
  setLaunchingGoal: Dispatch<SetStateAction<string | undefined>>;
  setNewGoalPrefill: Dispatch<SetStateAction<string | undefined>>;
  setNewGoalOpen: Dispatch<SetStateAction<boolean>>;
}) {
  // ── GG Coder: queue, ask_user, goals ──────────────────────
  const {
    gg,
    cancelQueued: cancelQueuedDaemon,
    answerAsk: answerAskDaemon,
    decidePlan: decidePlanDaemon,
    setAutopilot: setAutopilotDaemon,
    requestChecklist,
    requestTasks,
    refreshGoals,
    createGoal,
    goalAction,
    openGoal: openGoalDaemon,
    browseWorkspaces,
  } = daemon;
  const [goalSettingsOpen, setGoalSettingsOpen] = useState(() => devSheet === "goalsettings");
  const openSessionId = daemon.sessionId;
  const queuedHere = openSessionId ? gg.queues[openSessionId] : undefined;
  const askHere = openSessionId ? gg.asks[openSessionId]?.[0] : undefined;
  // A question the agent is blocked on gets the same call as an approval.
  const askId = askHere?.requestId;
  const lastAskId = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (askId && askId !== lastAskId.current) {
      haptics.attention();
    }
    lastAskId.current = askId;
  }, [askId]);
  const goalState = openSessionId ? gg.goalStates[openSessionId] : undefined;
  const goalHere =
    isGoalsProvider(daemon.effectiveProviderId ?? activeId) && (openSessionId || daemon.workspace)
      ? goalForSession(
          gg.goals,
          { sessionId: openSessionId, cwd: daemon.workspace?.cwd },
          goalState,
        )
      : undefined;
  // Goal header/roster/Ken line belong to GG Goals conversations only.
  const inGoal =
    isGoalsProvider(daemon.effectiveProviderId ?? activeId) &&
    (goalState !== undefined || goalHere !== undefined);

  // GG Goals ends a message with `[ken:face] words`: shown in the goal header,
  // never in the bubble.
  const shownTurns = useMemo(
    () => (inGoal ? withoutKenLines(daemon.turns) : daemon.turns),
    [inGoal, daemon.turns],
  );
  // Ken's latest spoken line, for the goal's ticker.
  const kenSays = useMemo(
    () => (inGoal ? latestKenSaying(daemon.turns) : null),
    [inGoal, daemon.turns],
  );
  const cancelQueued = useCallback(
    (id: string) => {
      if (openSessionId) cancelQueuedDaemon(openSessionId, id);
    },
    [openSessionId, cancelQueuedDaemon],
  );
  const planHere = openSessionId ? gg.plans[openSessionId] : undefined;
  const autopilotHere = openSessionId ? gg.autopilot[openSessionId] : undefined;
  const extensionsHere = gg.extensions[daemon.effectiveProviderId ?? ""];
  const stripsHere = ggStrips(
    daemon.effectiveProviderId,
    extensionsHere,
    openSessionId !== undefined,
  );
  const [checklistOpen, setChecklistOpen] = useState(() => devSheet === "checklist");
  const openChecklist = useCallback(() => setChecklistOpen(true), []);
  const checklistHere = openSessionId ? gg.checklists[openSessionId] : undefined;
  const [tasksOpen, setTasksOpen] = useState(() => devSheet === "tasks");
  const openTasks = useCallback(() => setTasksOpen(true), []);
  const tasksHere = openSessionId ? gg.tasks[openSessionId] : undefined;
  const decidePlan = useCallback(
    (generation: number, action: "accept" | "feedback" | "reject", feedback?: string) => {
      if (openSessionId) decidePlanDaemon(openSessionId, generation, action, feedback);
    },
    [openSessionId, decidePlanDaemon],
  );
  // Autopilot is a session setting, so a new GG Coder conversation has
  // nothing to set yet: a press there is remembered and applied the moment the
  // session exists, rather than showing a switch that does nothing.
  const [autopilotWanted, setAutopilotWanted] = useState(false);
  const toggleAutopilot = useCallback(() => {
    if (openSessionId) setAutopilotDaemon(openSessionId, !(autopilotHere?.enabled ?? false));
    else setAutopilotWanted((wanted) => !wanted);
  }, [openSessionId, autopilotHere?.enabled, setAutopilotDaemon]);
  useEffect(() => {
    if (!openSessionId || !autopilotWanted) return;
    setAutopilotWanted(false);
    setAutopilotDaemon(openSessionId, true);
  }, [openSessionId, autopilotWanted, setAutopilotDaemon]);

  // GG Goals and GG Coder have no mode dropdown: a goal runs on its own, and
  // GG Coder's slot is the Autopilot switch instead — a press turns it on or
  // off, no menu.
  const selectedAgent = daemon.effectiveProviderId ?? activeId;
  const ggAgent = isGoalsProvider(selectedAgent) || selectedAgent === "ggcoder";
  const autopilotOffered = selectedAgent === "ggcoder" && extensionsHere?.autopilot === true;
  const autopilotOn = openSessionId ? autopilotHere?.enabled === true : autopilotWanted;
  const autopilotReviewing = autopilotHere?.reviewing === true;
  // Open = ask; a `checklist changed` nudge or any session.idle bumps the nonce.
  useEffect(() => {
    if (checklistOpen && openSessionId) requestChecklist(openSessionId);
  }, [checklistOpen, openSessionId, gg.checklistNonce, requestChecklist]);
  // Same for tasks: open asks, and any session.idle (a turn may have ticked one off) re-asks.
  useEffect(() => {
    if (tasksOpen && openSessionId) requestTasks(openSessionId);
  }, [tasksOpen, openSessionId, gg.tasksNonce, requestTasks]);
  const answerAsk = useCallback(
    (requestId: string, result: AskResult) => {
      if (openSessionId) answerAskDaemon(openSessionId, requestId, result);
    },
    [openSessionId, answerAskDaemon],
  );
  // Messages handed back unsent (a cancelled turn) go into an empty draft only.
  const returnedNonce = gg.returned?.nonce;
  useEffect(() => {
    const returned = gg.returned;
    if (!returned || returned.sessionId !== openSessionId) return;
    const text = returnedDraft(returned.messages, composer.current?.getDraft() ?? "");
    if (text) composer.current?.setDraft(text);
    // Only on a new hand-back, not on every session switch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnedNonce]);
  const openGoal = useCallback(
    (goal: GoalSummary) => {
      setMenuOpen(false);
      openGoalDaemon(goal);
    },
    // The setters are the screen's state setters, handed in: stable.
    [openGoalDaemon, setMenuOpen],
  );
  const deleteGoal = useCallback(
    (goal: GoalSummary) => goalAction(goal.id, "delete"),
    [goalAction],
  );
  const openNewGoal = useCallback(
    (prefill?: string) => {
      setMenuOpen(false);
      setNewGoalPrefill(prefill);
      setNewGoalOpen(true);
    },
    [setMenuOpen, setNewGoalPrefill, setNewGoalOpen],
  );
  const closeNewGoal = useCallback(() => setNewGoalOpen(false), [setNewGoalOpen]);
  // The sheet closes itself once its launch has opened onto the session.
  const goalCreated = useCallback(
    (goal: GoalSummary | undefined) => {
      if (!goal) return;
      setLaunchingGoal(goal.name);
      openGoalDaemon(goal);
    },
    [openGoalDaemon, setLaunchingGoal],
  );
  // "Starting" ends when the kickoff turn lands, when the user goes to another
  // agent, or (nothing having arrived in a minute) on its own, leaving the
  // ordinary empty conversation rather than a spinner for ever.
  useEffect(() => {
    if (launchingGoal === undefined) return;
    if (daemon.turns.length > 0 || (activeId !== undefined && !isGoalsProvider(activeId))) {
      setLaunchingGoal(undefined);
      return;
    }
    const timer = setTimeout(() => setLaunchingGoal(undefined), 60_000);
    return () => clearTimeout(timer);
  }, [launchingGoal, daemon.turns.length, activeId, setLaunchingGoal]);
  const closeGoalSettings = useCallback(() => setGoalSettingsOpen(false), []);
  const openGoalSettings = useCallback(() => setGoalSettingsOpen(true), []);
  const goalId = goalHere?.id ?? goalState?.goalId;
  const goalPaused = goalState?.paused ?? goalHere?.status === "paused";
  const pauseGoal = useCallback(() => {
    if (goalId) goalAction(goalId, "pause");
  }, [goalId, goalAction]);
  const resumeGoal = useCallback(() => {
    if (goalId) goalAction(goalId, "resume");
  }, [goalId, goalAction]);

  return {
    gg,
    refreshGoals,
    createGoal,
    goalAction,
    browseWorkspaces,
    openSessionId,
    queuedHere,
    askHere,
    goalState,
    goalHere,
    inGoal,
    shownTurns,
    kenSays,
    cancelQueued,
    planHere,
    stripsHere,
    checklistOpen,
    setChecklistOpen,
    openChecklist,
    checklistHere,
    tasksOpen,
    setTasksOpen,
    openTasks,
    tasksHere,
    decidePlan,
    ggAgent,
    autopilotOffered,
    autopilotOn,
    autopilotReviewing,
    toggleAutopilot,
    answerAsk,
    openGoal,
    deleteGoal,
    openNewGoal,
    closeNewGoal,
    goalCreated,
    goalSettingsOpen,
    closeGoalSettings,
    openGoalSettings,
    goalId,
    goalPaused,
    pauseGoal,
    resumeGoal,
  };
}
