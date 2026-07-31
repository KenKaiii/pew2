import { expect, test } from "bun:test";
import { alignCompletedHistoryToBottom } from "./historyScroll";

test("completed history aligns the final transcript to its newest message", () => {
  const calls: { animated: boolean }[] = [];

  alignCompletedHistoryToBottom({ scrollToEnd: (options) => calls.push(options) });

  expect(calls).toEqual([{ animated: false }]);
});

test("a completed history alignment tolerates an unmounted scroller", () => {
  expect(() => alignCompletedHistoryToBottom(null)).not.toThrow();
});
