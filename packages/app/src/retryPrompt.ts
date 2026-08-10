/**
 * Which failed prompt can be sent again, and what it said.
 *
 * A failure is terminal in this transcript: the agent rejects a turn, a red
 * line lands under the message, and the only way forward is to type the prompt
 * out a second time — on a phone, from memory, having just watched the first
 * attempt fail. The text is right there on screen.
 *
 * Only the end of the thread offers it, and deliberately. A system line halfway
 * up is history: the conversation moved past it, and re-running a prompt from
 * before three later turns would run it against a context that no longer
 * resembles the one it failed in. The tail is the only place where "again"
 * means what it says.
 *
 * Pure and React-free so the rule is directly testable, like `chunks.ts`.
 */
import type { Turn } from "./useDaemon";

export type RetryTarget = {
  /** The failed turn's list key, so only that cell draws the control. */
  key: string;
  /** The prompt to send again, exactly as it was sent. */
  prompt: string;
};

export function retryTarget(turns: Turn[]): RetryTarget | undefined {
  const last = turns[turns.length - 1];
  if (last?.role !== "system") return undefined;

  // Walk back to the prompt this failure belongs to, stepping over the agent's
  // own partial reply and its reasoning — an agent that streams half an answer
  // and then rejects the turn leaves both between the two.
  for (let index = turns.length - 2; index >= 0; index -= 1) {
    const turn = turns[index]!;
    // A second system line above this one means the earlier failure has already
    // had its turn at being retried; stop rather than reach past it.
    if (turn.role === "system") return undefined;
    if (turn.role !== "user") continue;
    const prompt = turn.text.trim();
    // A prompt that was nothing but an attachment has no text to resend. The
    // files are long gone from the composer, so there is nothing to repeat.
    return prompt ? { key: last.key ?? last.id, prompt } : undefined;
  }

  // A failure with no prompt above it: a conversation that could not be loaded,
  // or an agent that died between starting and being asked anything. Nothing to
  // send again — reopening it is the recovery, and the message says so.
  return undefined;
}
