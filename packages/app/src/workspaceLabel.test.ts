import { expect, test } from "bun:test";
import { changesAccessibilityLabel, changesLabel } from "./workspaceLabel";

test("a dirty tree is counted, a clean one is named", () => {
  expect(changesLabel(2)).toBe("2 uncommitted");
  expect(changesLabel(1)).toBe("1 uncommitted");
  expect(changesLabel(0)).toBe("clean");
});

test("screen readers get whole sentences, singular included", () => {
  expect(changesAccessibilityLabel(1)).toBe("1 uncommitted file");
  expect(changesAccessibilityLabel(3)).toBe("3 uncommitted files");
  expect(changesAccessibilityLabel(0)).toBe("Working directory clean");
});
