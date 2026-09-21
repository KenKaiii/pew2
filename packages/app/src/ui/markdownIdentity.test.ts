import { expect, test } from "bun:test";
import { normalizeMarkdownKeys, splitWords, isProsePath } from "./markdownIdentity";
const tree = (text: string, type = "paragraph", key = "random") => [{ type, key, children: [{ type: "text", key: "random-text", content: text, children: [] }] }];
test("fresh parser keys do not remount unchanged/growing text", () => {
  const before = normalizeMarkdownKeys(tree("Hello"));
  const after = normalizeMarkdownKeys(tree("Hello world", "paragraph", "other"));
  expect(before[0]!.key).toBe(after[0]!.key);
  expect(before[0]!.children[0]!.key).toBe(after[0]!.children[0]!.key);
  expect(splitWords("Hello world")[0]).toBe(splitWords("Hello world grows")[0]);
});
test("structural changes do not inherit unrelated text reveal state", () => {
  const a = normalizeMarkdownKeys(tree("same"));
  const b = normalizeMarkdownKeys(tree("same", "code_block"));
  expect(a[0]!.children[0]!.key).not.toBe(b[0]!.children[0]!.key);
  expect(normalizeMarkdownKeys(tree("same"), "message-b")[0]!.key).not.toBe(a[0]!.key);
});
test("attributes are deterministic but changed links get a new identity", () => {
  const node = { ...tree("label")[0]!, type: "link", attributes: { href: "https://example.com", title: "example" } };
  const reordered = { ...node, attributes: { title: "example", href: "https://example.com" } };
  expect(normalizeMarkdownKeys([node])[0]!.key).toBe(normalizeMarkdownKeys([reordered])[0]!.key);
  expect(normalizeMarkdownKeys([node])[0]!.key).not.toBe(normalizeMarkdownKeys([{ ...node, attributes: { href: "https://other.example" } }])[0]!.key);
});
test("does not mutate the parser AST", () => {
  const source = tree("hello");
  normalizeMarkdownKeys(source);
  expect(source[0]!.key).toBe("random");
  expect(source[0]!.children[0]!.key).toBe("random-text");
});
test("segmentation preserves multilingual text and whitespace exactly", () => {
  const text = "Hello  世界\n\t👩🏽‍💻 e\u0301\r\n";
  expect(splitWords(text).join("")).toBe(text);
  expect(splitWords("")).toEqual([]);
});
test("code, HTML and math are opaque", () => {
  for (const type of ["code_inline", "code_block", "fence", "math_inline", "html_inline"]) expect(isProsePath(["paragraph", type])).toBe(false);
  expect(isProsePath(["paragraph", "strong", "link"])).toBe(true);
});
