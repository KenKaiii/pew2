/**
 * Copying text out of a message is the platform's job, not ours.
 *
 * There was an app-owned answer here: holding a turn opened a sheet containing
 * the whole message as one selectable node. It was built because iOS cannot
 * drag a selection across separate `Text` nodes and a rendered reply is dozens
 * of them — but the price was that a hold anywhere in the transcript stopped
 * doing what a hold does in every other app. This is the rule that replaced it,
 * and it is easy to undo by accident: `selectable` is one word, it has no
 * visible effect until someone holds a paragraph, and the renderer's own
 * defaults do not set it.
 *
 * Read from source, like `keyboardDismissal.test.ts`: there is no renderer in
 * this suite, and what is being protected is a decision about where one prop is
 * said rather than anything computed.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

function source(file: string): string {
  return readFileSync(join(import.meta.dir, file), "utf8");
}

test("every kind of message block is selectable", () => {
  const markdown = source("MarkdownText.tsx");

  // Two rules, because a block's outermost Text is one of two things, and only
  // the outermost one becomes a native view that owns the selection gesture:
  // `paragraph` for prose, `textgroup` for everything else the renderer builds
  // out of inline runs — headings, list items, table cells.
  const selectable = markdown.match(/selectable: true/g) ?? [];
  expect(selectable).toHaveLength(2);
  expect(markdown).toContain("textgroup:");

  // The third: a fenced block, which is its own Text and keeps its own Copy
  // button beside it.
  expect(markdown).toContain("<Text selectable style={textStyle}>");
});

test("no gesture of ours sits on top of a message", () => {
  // The sheet is gone, and so is the hold that opened it. If a long press over
  // a message ever means something app-specific again, it takes the platform's
  // selection with it — that is the whole trade this replaced.
  const turn = source("Turn.tsx");
  expect(turn).not.toContain("onLongPress");
});
