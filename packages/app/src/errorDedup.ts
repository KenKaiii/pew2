/**
 * Reconciling a failure that arrives twice.
 *
 * An agent typically streams its failure as ordinary message text and *then*
 * rejects the turn, so the same sentence lands once as agent output and once as
 * an error. Both are real messages, so neither transport can drop one blindly —
 * only the client knows what is already on screen.
 *
 * The answer is to keep one copy and mark it as the failure it is, rather than
 * showing it twice or showing it once in a colour that says nothing went wrong.
 *
 * Kept pure and React-free so the matching rule is directly testable.
 */

interface VisibleTurn {
  role: "user" | "agent" | "thought" | "system";
  text: string;
}

/**
 * Below this, a repeated fragment is too generic to be confident about.
 * "Cancelled." appearing in a long reply is a coincidence, not a duplicate.
 */
const MIN_CONTAINED_LENGTH = 20;

function canonical(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^(?:(?:internal\s+)?error:\s*)+/i, "")
    .replace(/[.!\s]+$/, "")
    .toLocaleLowerCase();
}

/**
 * Index of the turn already showing this error, or -1.
 *
 * Only the current turn is considered: the same failure twice in one thread is
 * two genuine events, and collapsing them would hide a repeat.
 */
export function findDuplicateError(turns: readonly VisibleTurn[], message: string): number {
  const error = canonical(message);
  if (!error) return -1;

  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index];
    // A user prompt ends the current turn; anything above it is history.
    if (!turn || turn.role === "user") break;
    if (turn.role === "thought") continue;

    const text = canonical(turn.text);
    if (!text) continue;
    // Containment as well as equality: agents often wrap the same sentence in a
    // little prose ("Sorry — <reason>") before rejecting the turn.
    if (text === error) return index;
    if (error.length >= MIN_CONTAINED_LENGTH && text.includes(error)) return index;
  }

  return -1;
}
