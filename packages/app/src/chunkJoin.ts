/**
 * Joining two agent message chunks into one bubble.
 *
 * ACP gives no hint whether a chunk continues the last one or starts a new
 * message, and agents mean different things by it. Captured from the real
 * agents:
 *
 *   Claude Code   "Let me check"          + " that.\n\nAh, I found it."
 *   GG Coder      "Let me check that."    + "Ah, I found it."
 *
 * The first is a token stream: the split falls mid-sentence and the second
 * chunk carries its own leading space. Concatenating is exactly right, and
 * inserting anything would break a word in half.
 *
 * The second is two finished messages, sent as the agent worked. Concatenating
 * gives "Let me check that.Ah, I found it." — the bug this exists to fix.
 *
 * The tell is the seam, not the agent: a stream keeps its whitespace, so a
 * space on either side means continue. A sentence that *ends* against a word
 * that *begins* is two messages that were never joined by anyone. Deciding per
 * seam rather than per provider means an agent that streams sometimes and
 * batches other times is still right both times, and a new agent needs no
 * entry in a table.
 *
 * Pure and Expo-free, so `bun test` can load it.
 */

/**
 * Ends a thought: terminal punctuation, allowing one closing bracket, quote or
 * backtick after it (`(done.)`, `"stop."`, `` `x.` ``).
 *
 * Requiring a real character *before* the stop does two jobs at once. It keeps
 * a streamed decimal safe — "3." + "14" ends in a full stop and begins with a
 * character, but is one number — and it means punctuation arriving as its own
 * token (agents do emit a bare ".") is never mistaken for the end of a message.
 * Both failures would split a sentence, which is the direction that matters.
 */
const ENDS_SENTENCE = /[^\d\s][.!?:…]["'`)\]]?$/;

/**
 * Begins one: a capital, a digit-led list item, or a markdown block marker.
 *
 * Deliberately narrow. A lowercase word after a full stop is far more likely to
 * be a stream that happened to split there than a new message, and the cost of
 * guessing wrong in that direction is a broken sentence.
 */
const STARTS_SENTENCE = /^(?:[A-Z]|[-*+] |#{1,6} |\d+[.)] |> |```)/;

/**
 * The separator to place between two chunks in the same bubble.
 *
 * A blank line rather than a single newline: these are distinct messages the
 * agent emitted at different moments, and markdown needs the blank line to
 * render them as separate paragraphs at all.
 */
export function chunkJoiner(before: string, after: string): string {
  if (!before || !after) return "";
  // Whitespace at the seam: the stream already spaced itself, and anything
  // added here would be a second space or a break mid-sentence.
  if (/\s$/.test(before) || /^\s/.test(after)) return "";
  if (!ENDS_SENTENCE.test(before)) return "";
  if (!STARTS_SENTENCE.test(after)) return "";
  return "\n\n";
}

/** `before` and `after` joined by whatever the seam calls for. */
export function joinChunks(before: string, after: string): string {
  return before + chunkJoiner(before, after) + after;
}
