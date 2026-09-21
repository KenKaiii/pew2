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

test("composer menus open upward, keeping the keyboard and trigger clear", () => {
  const layout = fitPickerToViewport({ ...base, anchorX: 24, menuBottom: 480 });
  expect(layout).toEqual({ left: 24, width: 300, maxHeight: 360, bottom: 364, origin: "bottom left" });
  expect(base.viewportHeight - layout.bottom! - layout.maxHeight).toBeGreaterThanOrEqual(base.insets.top + base.margin);
});

test("composer menus shrink above a raised keyboard and clamp stale anchors", () => {
  const layout = fitPickerToViewport({ ...base, anchorX: 310, menuBottom: 200 });
  expect(layout).toEqual({ left: 70, width: 300, maxHeight: 133, bottom: 644, origin: "bottom right" });
  const low = fitPickerToViewport({ ...base, menuBottom: 2000 });
  expect(low.bottom).toBe(base.insets.bottom + base.margin);
  const high = fitPickerToViewport({ ...base, menuBottom: -100 });
  expect(high.maxHeight).toBe(0);
});

test("keeps a left anchor when it already fits", () => {
  expect(fitPickerToViewport({ ...base, anchorX: 24 }).left).toBe(24);
  expect(fitPickerToViewport({ ...base, anchorX: 24 }).origin).toBe("top left");
});
