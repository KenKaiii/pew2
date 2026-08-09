import { expect, test } from "bun:test";
import { heightAction } from "./settledHeight";

test("the first measurement is reported immediately", () => {
  // Deferring it would leave the thread on its analytic fallback for two extra
  // frames at launch, which reads as the last message sitting under the dock.
  expect(heightAction(0, 109)).toBe("report-now");
});

test("a height that has not changed is ignored", () => {
  // `onLayout` fires for reasons unrelated to growth — a keyboard frame, a
  // parent re-layout. Treating those as changes would restart the settle timer
  // forever and re-report a height React already has.
  expect(heightAction(109, 109)).toBe("ignore");
});

test("growth mid-animation is deferred rather than reported per frame", () => {
  // The measured cost of reporting every frame: a wrapped line arrives as about
  // eleven separate two-pixel layout passes, each one re-rendering the app on
  // the frames the growth animation needs.
  expect(heightAction(109, 111)).toBe("defer");
  expect(heightAction(111, 113)).toBe("defer");
  expect(heightAction(131, 109)).toBe("defer");
});
