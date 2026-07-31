import { expect, test } from "bun:test";
import { fitPickerToViewport } from "./pickerLayout";

const base = {
  viewportWidth: 390,
  viewportHeight: 844,
  menuTop: 100,
  insets: { top: 47, right: 0, bottom: 34, left: 0 },
  margin: 20,
  preferredWidth: 300,
  maximumHeight: 360,
};

test("shifts a right-anchored dropdown inside the viewport", () => {
  expect(fitPickerToViewport({ ...base, anchorX: 260 })).toEqual({
    left: 70,
    width: 300,
    maxHeight: 360,
    origin: "top right",
  });
});

test("shrinks dropdown width and height on a small viewport", () => {
  const layout = fitPickerToViewport({
    ...base,
    viewportWidth: 240,
    viewportHeight: 320,
    anchorX: 180,
  });

  expect(layout).toEqual({
    left: 20,
    width: 200,
    maxHeight: 166,
    origin: "top right",
  });
  expect(layout.left + layout.width).toBeLessThanOrEqual(220);
  expect(base.menuTop + layout.maxHeight).toBeLessThanOrEqual(286);
});

test("keeps a left anchor when it already fits", () => {
  expect(fitPickerToViewport({ ...base, anchorX: 24 }).left).toBe(24);
  expect(fitPickerToViewport({ ...base, anchorX: 24 }).origin).toBe("top left");
});
