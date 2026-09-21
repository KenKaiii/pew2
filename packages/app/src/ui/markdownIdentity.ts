/** Pure structural keys for the installed renderer's fresh AST keys.
 * Text content is excluded so appending to a word does not remount it.
 * Message/replay identity belongs on the enclosing block, not on chunk seq.
 */
interface StructuralNode {
  type: string;
  key: string;
  tag?: string;
  markup?: string;
  attributes?: Record<string, unknown>;
  children: StructuralNode[];
}
export function normalizeMarkdownKeys<T extends StructuralNode>(nodes: readonly T[], root = "md"): T[] {
  return nodes.map((node, index) => {
    const attributes = Object.entries(node.attributes ?? {}).sort(([a], [b]) => a.localeCompare(b));
    const key = `${root}/${index}:${JSON.stringify([node.type, node.tag, node.markup, attributes])}`;
    return { ...node, key, children: normalizeMarkdownKeys(node.children, key) } as T;
  });
}

/** GG rehype-animate-words.ts splitWords: preserve every whitespace seam. */
export function splitWords(text: string): string[] { return text.match(/\s+|\S+/g) ?? []; }
export function isProsePath(types: readonly string[]): boolean {
  return !types.some((type) => /code|fence|math|html/.test(type));
}
