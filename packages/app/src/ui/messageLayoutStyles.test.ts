import { expect, test } from "bun:test";
import {
  adaptiveUserBubbleStyle,
  blockUserBubbleStyle,
  boundedMarkdownParagraphStyle,
  boundedMarkdownRootStyle,
  userPromptNeedsFullWidth,
} from "./messageLayoutStyles";

test("user prompts hug short content but cannot exceed the full message rail", () => {
  expect(adaptiveUserBubbleStyle).toEqual({
    maxWidth: "100%",
    minWidth: 0,
    flexShrink: 1,
  });
  expect(adaptiveUserBubbleStyle).not.toHaveProperty("width");
});

test("markdown text resolves percentage widths inside its bubble", () => {
  expect(boundedMarkdownRootStyle).toMatchObject({ maxWidth: "100%", minWidth: 0 });
  expect(boundedMarkdownParagraphStyle).toMatchObject({
    width: "100%",
    maxWidth: "100%",
    minWidth: 0,
    flexShrink: 1,
  });
});

test("ordered-list prompts receive a definite full-width rail instead of collapsing", () => {
  const listPrompt = "1. Inspect the app\n2. Run the checks\n3. Report the result";
  expect(userPromptNeedsFullWidth(listPrompt)).toBe(true);
  expect(blockUserBubbleStyle).toEqual({ width: "100%" });
});

test("short prose keeps its intrinsic content-sized bubble", () => {
  expect(userPromptNeedsFullWidth("Thanks.")).toBe(false);
  expect(userPromptNeedsFullWidth("A short sentence that wraps naturally.")).toBe(false);
});