/**
 * The topmost sheets: New goal and goal settings, then everything the agent
 * is blocked on (approval, ask_user, plan review), the checklist and tasks.
 */
import { useEffect, useState } from "react";
import { NewGoalSheet } from "./NewGoalSheet";
import { GoalSettingsSheet } from "./GoalSettingsSheet";
import { ApprovalSheet } from "./ApprovalSheet";
import { AskUserSheet } from "./AskUserSheet";
import { ChecklistSheet, PlanReviewSheet } from "./GgReview";
import { TasksSheet } from "./TasksSheet";
import type { useDaemon } from "../useDaemon";
import { inboxItemId } from "../voiceCall";
import type { useGoalControls } from "../useGoalControls";

export function GoalSheets({
  daemon,
  goals,
  newGoalOpen,
  newGoalPrefill,
  answerPermission,
  send,
  onTalk,
}: {
  daemon: ReturnType<typeof useDaemon>;
  goals: ReturnType<typeof useGoalControls>;
  /** Start a call focused on an inbox item id; absent without voice. */
  onTalk?: (focus: string) => void;
  newGoalOpen: boolean;
  newGoalPrefill: string | undefined;
  answerPermission: (requestId: string, optionId: string, deny: boolean) => void;
  send: (text: string) => boolean;
}) {
  const {
    gg,
    createGoal,
    goalAction,
    browseWorkspaces,
    askHere,
    goalState,
    goalHere,
    planHere,
    stripsHere,
    checklistOpen,
    setChecklistOpen,
    checklistHere,
    tasksOpen,
    setTasksOpen,
    tasksHere,
    decidePlan,
    answerAsk,
    closeNewGoal,
    goalCreated,
    goalSettingsOpen,
    closeGoalSettings,
  } = goals;
  // A Run is answered by the daemon: one it refused (busy, or the task deleted or
  // finished at the desk) reopens the sheet saying why. Accepted, this chat clears and runs it.
  const [pendingRun, setPendingRun] = useState<{ requestId: string; sessionId: string }>();
  // Held apart from the list: reopening re-asks, and that fresh answer carries no error.
  const [runError, setRunError] = useState<string>();
  const runAnswer = pendingRun ? gg.tasks[pendingRun.sessionId] : undefined;
  useEffect(() => {
    if (!pendingRun || runAnswer?.requestId !== pendingRun.requestId) return;
    setPendingRun(undefined);
    if (!runAnswer.error) return;
    setRunError(runAnswer.error);
    setTasksOpen(true);
  }, [pendingRun, runAnswer, setTasksOpen]);
  // "Talk it through" focuses the call on the inbox item this sheet shows.
  const talkSession = daemon.sessionId;
  const talkAbout = (kind: "approval" | "question") =>
    onTalk && talkSession
      ? (requestId: string) => onTalk(inboxItemId(talkSession, kind, requestId))
      : undefined;
  return (
    <>
      {/* Last of every overlay on purpose. All the sheets share one zIndex, so
          paint order is sibling order — and an approval the agent is blocked on
          must sit above anything the user happened to have open. */}
      <NewGoalSheet
        visible={newGoalOpen}
        onClose={closeNewGoal}
        onCreate={createGoal}
        results={gg.goalResults}
        onCreated={goalCreated}
        browse={daemon.browse}
        onBrowse={browseWorkspaces}
        prefill={newGoalPrefill}
        online={daemon.status === "online"}
      />
      <GoalSettingsSheet
        visible={goalSettingsOpen}
        goal={goalHere}
        state={goalState}
        onAction={goalAction}
        results={gg.goalResults}
        modelOption={daemon.providerConfigs.ggcoder?.find((option) => option.id === "model")}
        onClose={closeGoalSettings}
        browse={daemon.browse}
        onBrowse={browseWorkspaces}
        online={daemon.status === "online"}
      />

      <ApprovalSheet
        permission={daemon.permission}
        onAnswer={answerPermission}
        onTalk={talkAbout("approval")}
      />
      {/* Same rule as the approval: a question the agent is blocked on sits
          above whatever else is open. Never raised by a replay batch. */}
      <AskUserSheet ask={askHere} onAnswer={answerAsk} onTalk={talkAbout("question")} />
      <PlanReviewSheet
        plan={stripsHere.plan ? (planHere?.pending ?? undefined) : undefined}
        busy={daemon.busy}
        onDecide={decidePlan}
      />
      <ChecklistSheet
        visible={checklistOpen}
        items={checklistHere?.items}
        error={checklistHere?.error}
        busy={daemon.busy}
        onClose={() => setChecklistOpen(false)}
        onRun={(prompt) => {
          setChecklistOpen(false);
          send(prompt);
        }}
      />
      <TasksSheet
        visible={tasksOpen}
        items={tasksHere?.items}
        error={runError ?? tasksHere?.error}
        online={daemon.status === "online"}
        busy={daemon.busy}
        onClose={() => {
          setRunError(undefined);
          setTasksOpen(false);
        }}
        onRun={(task) => {
          setRunError(undefined);
          const sessionId = daemon.sessionId;
          if (!task.runPrompt || !sessionId) return;
          const requestId = daemon.startTask(sessionId, task.id);
          if (!requestId) return;
          setPendingRun({ requestId, sessionId });
          setTasksOpen(false);
        }}
      />
    </>
  );
}
