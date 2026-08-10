import { expect, test } from "bun:test";
import { messageCopyIsDuplicate } from "./messageActions";

test("a reply that is nothing but one fence already has its Copy", () => {
  expect(messageCopyIsDuplicate("```ts\nexport const answer = 42;\n```")).toBe(true);
  // No language, tildes, and surrounding blank lines: all the same block.
  expect(messageCopyIsDuplicate("```\nplain\n```")).toBe(true);
  expect(messageCopyIsDuplicate("~~~py\nprint(1)\n~~~")).toBe(true);
  expect(messageCopyIsDuplicate("\n\n```sh\nls -la\n```\n\n")).toBe(true);
  // Up to three spaces of indent still opens a fence, per CommonMark.
  expect(messageCopyIsDuplicate("  ```\ncode\n  ```")).toBe(true);
});

test("a block still streaming in counts, so the button never flickers", () => {
  // Mid-stream the closing fence has not arrived, but the renderer is already
  // painting this as code. Disagreeing would show a Copy for one frame.
  expect(messageCopyIsDuplicate("```ts\nexport const answ")).toBe(true);
});

test("prose beside the code is what the message button is for", () => {
  // The block's button takes the code; this one takes the answer. Usually the
  // sentence explaining it is the half worth keeping.
  expect(messageCopyIsDuplicate("Here you go:\n\n```ts\nconst a = 1;\n```")).toBe(false);
  expect(messageCopyIsDuplicate("```ts\nconst a = 1;\n```\n\nThat sets `a`.")).toBe(false);
});

test("two blocks are not one block", () => {
  // Neither block's button yields both, so the message still needs its own.
  expect(messageCopyIsDuplicate("```ts\na\n```\n\n```ts\nb\n```")).toBe(false);
});

test("ordinary replies keep their button", () => {
  expect(messageCopyIsDuplicate("Done — the tests pass.")).toBe(false);
  // Inline code is not a block and has no button of its own.
  expect(messageCopyIsDuplicate("Run `npm test` first.")).toBe(false);
  // An indented block is not fenced, and the renderer gives it no header.
  expect(messageCopyIsDuplicate("    const a = 1;")).toBe(false);
  expect(messageCopyIsDuplicate("")).toBe(false);
  expect(messageCopyIsDuplicate("   ")).toBe(false);
});
