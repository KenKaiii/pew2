/** Explicit, displayable thought blocks only; never signatures or hidden reasoning. */
export function historyThoughts(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content.flatMap((part) => {
    if (part?.type !== "thinking" && part?.type !== "reasoning") return [];
    const text = part.thinking ?? part.text;
    return typeof text === "string" ? [text] : [];
  }).join("\n");
}
