import { expect, test } from "bun:test";
import { HISTORY_PAGE_SIZE, nextHistoryLimit, visibleHistoryTurns } from "./historyWindow";

test("history initially mounts only the 15 newest turns", () => {
  const turns = Array.from({ length: 40 }, (_, index) => index + 1);
  expect(visibleHistoryTurns(turns, HISTORY_PAGE_SIZE)).toEqual(
    Array.from({ length: 15 }, (_, index) => index + 26),
  );
});

test("scrolling upward reveals one older page without exceeding history", () => {
  expect(nextHistoryLimit(15, 40)).toBe(30);
  expect(nextHistoryLimit(30, 40)).toBe(40);
  expect(nextHistoryLimit(40, 40)).toBe(40);
});
