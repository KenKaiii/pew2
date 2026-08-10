/**
 * Whether a reply's own Copy button would only repeat one already on screen.
 *
 * A fenced code block carries a Copy in its header, and has since before whole
 * replies could be copied at all. When the entire reply *is* that one fence, the
 * two buttons put the identical string on the clipboard, a few pixels apart, one
 * directly beneath the other — the second is not a second option, it is the same
 * option drawn twice, and the first is the one sitting on the thing it copies.
 *
 * Only that exact case. A reply that explains something and then shows the code
 * is not a duplicate: the block's button takes the code, and the message's takes
 * the answer — the sentence about what the code does is usually the half worth
 * keeping. Two fences with nothing between them are not one either, since
 * neither block button yields both.
 *
 * Pure and React-free so the rule is testable, like `messageLayoutStyles.ts`.
 */

/**
 * An opening fence: three or more backticks or tildes, up to three spaces in,
 * with an optional info string after it. CommonMark's rule, and the renderer's.
 */
const OPENS = /^ {0,3}(`{3,}|~{3,})/;

/**
 * Walked line by line rather than matched as one pattern, because the closing
 * fence is defined *relative to the opening one* — same character, at least as
 * long — and because what matters is not "does a block match" but "is there
 * anything after the first one ends". A single expression can be made to say
 * that, but not legibly, and it silently starts answering a different question
 * the moment a second block appears.
 */
export function messageCopyIsDuplicate(text: string): boolean {
  const lines = text.trim().split("\n");
  const opening = OPENS.exec(lines[0] ?? "")?.[1];
  if (!opening) return false;

  const closes = new RegExp(`^ {0,3}\\${opening[0]}{${opening.length},}\\s*$`);
  for (let index = 1; index < lines.length; index += 1) {
    if (!closes.test(lines[index]!)) continue;
    // Anything past the close is content the block's own button cannot reach —
    // a second block, or a sentence about the first — and that is exactly when
    // the message needs a button of its own.
    return lines.slice(index + 1).every((line) => !line.trim());
  }

  // Never closed, which is what a block still streaming in looks like. The
  // renderer is already painting it as code, so this has to agree: disagreeing
  // shows a second Copy for the frames between the opening fence and the
  // closing one.
  return true;
}
