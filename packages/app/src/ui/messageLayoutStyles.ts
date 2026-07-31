/** Long prompts may consume the full rail; short prompts retain intrinsic width. */
export const adaptiveUserBubbleStyle = {
  maxWidth: "100%",
  minWidth: 0,
  flexShrink: 1,
} as const;

/** Block Markdown rows use flex children and therefore need a definite rail. */
export const blockUserBubbleStyle = { width: "100%" } as const;

const BLOCK_MARKDOWN =
  /(?:^|\n)[ \t]{0,3}(?:#{1,6}\s|>\s?|(?:[-+*]|\d+[.)])\s+|```|~~~|(?: {4}|\t)\S)/;

export function userPromptNeedsFullWidth(text: string): boolean {
  return (
    BLOCK_MARKDOWN.test(text) ||
    text.includes("\n\n") ||
    /\n\s*\|?\s*:?-{3,}/.test(text)
  );
}

/** Percentage-width Markdown descendants must resolve inside their message rail. */
export const boundedMarkdownRootStyle = {
  maxWidth: "100%",
  minWidth: 0,
  flexShrink: 1,
} as const;

export const boundedMarkdownParagraphStyle = {
  width: "100%",
  maxWidth: "100%",
  minWidth: 0,
  flexShrink: 1,
} as const;
