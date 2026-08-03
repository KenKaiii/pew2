import { expect, test } from "bun:test";
import { chunkJoiner, joinChunks } from "./chunkJoin";

// Every case below is a real capture from the agent named, taken by driving it
// over ACP directly. The two shapes are what the whole rule exists to tell
// apart, so they are pinned rather than paraphrased.

test("Claude Code streams mid-word and must be concatenated untouched", () => {
  // Captured: "Let me check" + " that.\n\nAh, I found it."
  expect(joinChunks("Let me check", " that.\n\nAh, I found it.")).toBe(
    "Let me check that.\n\nAh, I found it.",
  );
});

test("GG Coder sends finished messages and must be separated", () => {
  // Captured: "Let me check that." + "Ah, I found it." — the reported bug,
  // which rendered as "Let me check that.Ah, I found it."
  expect(joinChunks("Let me check that.", "Ah, I found it.")).toBe(
    "Let me check that.\n\nAh, I found it.",
  );
});

test("a blank line, not a single newline", () => {
  // Markdown renders a single newline as a soft wrap, so two messages would
  // still read as one paragraph.
  expect(chunkJoiner("Done.", "Next.")).toBe("\n\n");
});

test("whitespace already at the seam is left alone", () => {
  expect(chunkJoiner("Done. ", "Next.")).toBe("");
  expect(chunkJoiner("Done.", " Next.")).toBe("");
  expect(chunkJoiner("Done.\n\n", "Next.")).toBe("");
});

test("a sentence that has not ended is never broken", () => {
  // The expensive failure: splitting a stream mid-thought.
  expect(chunkJoiner("Let me check", "that file")).toBe("");
  expect(chunkJoiner("I will run", "the tests")).toBe("");
});

test("a lowercase continuation after a full stop stays joined", () => {
  // Ambiguous, and guessing "new message" here would break a real sentence,
  // so the narrow reading wins.
  expect(chunkJoiner("Checked v1.", "then moved on")).toBe("");
});

test("a streamed decimal is not two sentences", () => {
  // "3." ends with a full stop and "14" begins with a character: the digit
  // guard is the only thing standing between this and "3.\n\n14".
  expect(chunkJoiner("Version 3.", "14 is out")).toBe("");
  expect(joinChunks("pi is 3.", "14159")).toBe("pi is 3.14159");
});

test("markdown blocks start a new message", () => {
  // Agents that narrate then emit a list or a fence: without the break the
  // list marker lands on the end of the prose line and never renders.
  expect(chunkJoiner("Here is the plan.", "- First step")).toBe("\n\n");
  expect(chunkJoiner("Here is the code.", "```ts")).toBe("\n\n");
  expect(chunkJoiner("Steps:", "1. Do the thing")).toBe("\n\n");
  expect(chunkJoiner("Quoting:", "> a quotation")).toBe("\n\n");
  expect(chunkJoiner("A heading:", "## Title")).toBe("\n\n");
});

test("questions and exclamations end a message too", () => {
  expect(chunkJoiner("Shall I proceed?", "Actually, wait.")).toBe("\n\n");
  expect(chunkJoiner("Found it!", "Now fixing.")).toBe("\n\n");
  expect(chunkJoiner("Thinking…", "Done.")).toBe("\n\n");
});

test("closing punctuation after the stop still ends the sentence", () => {
  expect(chunkJoiner("(All done.)", "Next up.")).toBe("\n\n");
  expect(chunkJoiner('He said "stop."', "Then it stopped.")).toBe("\n\n");
});

test("an empty chunk on either side adds nothing", () => {
  expect(chunkJoiner("", "Next.")).toBe("");
  expect(chunkJoiner("Done.", "")).toBe("");
});

test("punctuation arriving as its own token never breaks the stream", () => {
  // Captured from GG Coder streaming: it emits "." as a whole chunk. The rule
  // needs a non-digit *before* the stop, which a lone "." cannot supply — so it
  // fails closed and joins. Fine in this direction: a missed break is a
  // cosmetic loss, a wrong one splits a sentence.
  expect(chunkJoiner(".", "Ah")).toBe("");
  expect(chunkJoiner("!", "Yes")).toBe("");
});

/**
 * Whole chunk sequences, exactly as each agent emitted them over ACP.
 *
 * Folded the way the app folds them, so these assert the rendered bubble
 * rather than one seam — the level at which the bug was actually visible.
 */
function fold(chunks: string[]): string {
  return chunks.reduce((text, chunk) => joinChunks(text, chunk));
}

test("messages separated by tool calls are separated on screen", () => {
  // The reported case, from the screenshot. Tool calls do not create turns, so
  // three messages the agent sent either side of its work all coalesce into one
  // bubble — and used to render as "Let me check.Let me see if it's in a green
  // state.Typecheck is clean."
  expect(
    fold([
      "Let me check.",
      "Let me see if it's in a green state.",
      "Typecheck is clean. 10 tests fail though.",
    ]),
  ).toBe(
    "Let me check.\n\nLet me see if it's in a green state.\n\nTypecheck is clean. 10 tests fail though.",
  );
});

test("a token stream that spaces and breaks itself is left exactly alone", () => {
  // GG Coder streaming, captured live: it emits its own "  \n" break, so the
  // seam is already whitespace and nothing may be added.
  expect(fold(["Let", " me", " check", " that", ".", "  \n", "Ah", ",", " I", " found", " it"])).toBe(
    "Let me check that.  \nAh, I found it",
  );
});

test("every connected agent renders correctly from its real capture", () => {
  // Claude Code: a token stream that splits mid-phrase and spaces itself.
  expect(fold(["Let me check", " that.\n\nAh, I found it."])).toBe(
    "Let me check that.\n\nAh, I found it.",
  );

  // GG Coder: finished messages, plus a tool result that begins with its own
  // space and so must not gain a second break.
  expect(fold(["Let me check that.", "Ah, I found it.", " `/private/tmp/chunkprobe`"])).toBe(
    "Let me check that.\n\nAh, I found it. `/private/tmp/chunkprobe`",
  );

  // echo: word-by-word with trailing spaces. Every seam is already spaced, so
  // the whole reduction must be a plain concatenation.
  expect(fold(["You ", "said: ", "Let ", "me ", "check ", "that. "])).toBe(
    "You said: Let me check that. ",
  );
});
