import { expect, test } from "bun:test";
import { orderProvidersByRecency } from "./providerRecency";

const provider = (id: string, available = true) => ({ id, available });
const session = (providerId: string, startedAt: number) => ({ providerId, startedAt });

test("the most recently used app leads the row", () => {
  const ordered = orderProvidersByRecency(
    [provider("claude-code"), provider("ggcoder"), provider("codex")],
    [session("ggcoder", 200), session("claude-code", 100)],
  );

  expect(ordered.map((p) => p.id)).toEqual(["ggcoder", "claude-code", "codex"]);
});

test("unused apps keep their original order after the used ones", () => {
  const ordered = orderProvidersByRecency(
    [provider("codex"), provider("gemini-cli"), provider("ggcoder")],
    [session("ggcoder", 100)],
  );

  expect(ordered.map((p) => p.id)).toEqual(["ggcoder", "codex", "gemini-cli"]);
});

test("an unavailable app trails even with the freshest history", () => {
  const ordered = orderProvidersByRecency(
    [provider("ggcoder", false), provider("claude-code")],
    [session("ggcoder", 999), session("claude-code", 1)],
  );

  expect(ordered.map((p) => p.id)).toEqual(["claude-code", "ggcoder"]);
});

test("recency uses the newest session, not the first listed", () => {
  const ordered = orderProvidersByRecency(
    [provider("a"), provider("b")],
    [session("a", 50), session("b", 10), session("a", 5), session("b", 500)],
  );

  expect(ordered.map((p) => p.id)).toEqual(["b", "a"]);
});

test("no sessions at all preserves the original row", () => {
  const input = [provider("a"), provider("b"), provider("c")];
  expect(orderProvidersByRecency(input, []).map((p) => p.id)).toEqual(["a", "b", "c"]);
});
