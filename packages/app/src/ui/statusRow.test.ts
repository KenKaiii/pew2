import { expect, test } from "bun:test";
import { STATUS_ROW_MAX_FONT_SCALE, statusRowHeight } from "./statusRow";

/** Stands in for `theme.line.body`, which cannot be imported here: `theme.ts` */
/** pulls in react-native, whose Flow syntax `bun test` cannot parse. */
const LINE = 22;

test("the default text size is exactly one body line", () => {
  expect(statusRowHeight(LINE, 1)).toBe(LINE);
});

test("the row grows with the text it holds", () => {
  // The whole point: the box and the glyphs are multiplied by the same number,
  // so nothing clips on the way up.
  expect(statusRowHeight(LINE, 1.5)).toBe(33);
  expect(statusRowHeight(LINE, 2)).toBe(44);
});

test("a fractional scale lands on a whole pixel", () => {
  expect(Number.isInteger(statusRowHeight(LINE, 1.35))).toBe(true);
});

test("growth stops where the text is capped", () => {
  // iOS accessibility sizes reach ~3.1x. The row must agree with the
  // `maxFontSizeMultiplier` the text carries, or one of the two overflows.
  expect(statusRowHeight(LINE, 3.1)).toBe(statusRowHeight(LINE, STATUS_ROW_MAX_FONT_SCALE));
});

test("never smaller than a line, whatever the platform reports", () => {
  expect(statusRowHeight(LINE, 0.8)).toBe(LINE);
  expect(statusRowHeight(LINE, 0)).toBe(LINE);
  expect(statusRowHeight(LINE, Number.NaN)).toBe(LINE);
});

test("every row in the shared slot takes its height from here", () => {
  // Read from source, like `keyboardDismissal.test.ts`: what is protected is
  // that one number reaches all four rows, not anything computed. A fifth row
  // added to the transcript's footer belongs in this list too.
  for (const file of ["ChatThread.tsx", "ActivityLine.tsx", "TurnReceipt.tsx"]) {
    const source = Bun.file(new URL(file, import.meta.url).pathname).text();
    expect(source).resolves.toContain("useStatusRowHeight");
  }
});
