import { expect, test } from "bun:test";
import { splitMarkdownBlocks } from "./markdownBlocks";

test("splits a message into its top-level blocks", () => {
  expect(splitMarkdownBlocks("# Title\n\nA paragraph.\n\nAnother.")).toEqual([
    "# Title",
    "A paragraph.",
    "Another.",
  ]);
});

test("an ordered list stays one block, so its numbering cannot restart", () => {
  // The reason this uses a parser rather than splitting on blank lines. A
  // loose list has blank lines *between its own items*, and cutting there would
  // render three separate lists that each start again at 1.
  const blocks = splitMarkdownBlocks("Intro.\n\n1. first\n\n2. second\n\n3. third\n\nOutro.");
  expect(blocks).toHaveLength(3);
  expect(blocks[1]).toContain("1. first");
  expect(blocks[1]).toContain("2. second");
  expect(blocks[1]).toContain("3. third");
});

test("a fenced block stays whole, blank lines inside it included", () => {
  const blocks = splitMarkdownBlocks("Before.\n\n```js\nconst a = 1;\n\nconst b = 2;\n```\n\nAfter.");
  expect(blocks).toHaveLength(3);
  expect(blocks[1]).toBe("```js\nconst a = 1;\n\nconst b = 2;\n```");
});

test("an unterminated fence is one block, as it is mid-stream", () => {
  // What a code block looks like on every frame while it is being written.
  const blocks = splitMarkdownBlocks("Here:\n\n```js\nconst a = 1;");
  expect(blocks).toHaveLength(2);
  expect(blocks[1]).toBe("```js\nconst a = 1;");
});

test("blocks already written stay byte-identical as more text streams in", () => {
  // The property the whole optimisation rests on: if a completed block changed
  // identity as the message grew, memoising it would achieve nothing.
  const full = "# Title\n\nFirst paragraph.\n\n- a\n- b\n\n```js\nconst a = 1;\n```\n\nDone.";
  const finished = splitMarkdownBlocks(full);

  for (let length = 1; length <= full.length; length++) {
    const partial = splitMarkdownBlocks(full.slice(0, length));
    // Every block before the one still being written must already equal its
    // final form. The last is allowed to differ; it is mid-sentence.
    for (let index = 0; index < partial.length - 1; index++) {
      expect(partial[index]).toBe(finished[index]);
    }
  }
});

test("empty input renders nothing rather than an empty block", () => {
  expect(splitMarkdownBlocks("")).toEqual([]);
});

test("text with no block token is still returned rather than dropped", () => {
  // Whitespace parses to no tokens at all. Losing it silently would be worse
  // than laying it out oddly.
  expect(splitMarkdownBlocks("   ")).toEqual(["   "]);
});
