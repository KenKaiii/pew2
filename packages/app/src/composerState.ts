/**
 * When the composer offers to stop the agent.
 *
 * Split out and tested because getting it wrong is invisible to types and
 * obvious to the user: reopening a past conversation sets `busy` while its
 * history loads, and every agent that replays over ACP takes a couple of
 * seconds to do it. For that window the composer showed a stop button for a
 * turn nobody had started, and pressing it cancelled a session that was not
 * running.
 *
 * It looked fine in testing because Claude Code and ggcoder read their history
 * straight off local disk and arrive too fast to notice.
 */
export function showsStop(state: { busy: boolean; loadingSession: boolean }): boolean {
  return state.busy && !state.loadingSession;
}
