/**
 * Regression net for the recycled-onLayout crash.
 *
 * The reported error was `TypeError: Cannot read property 'layout' of null`,
 * thrown when a setState updater dereferenced `nativeEvent` after React had
 * already recycled the synthetic event.
 */
import { test, expect } from "bun:test";
import { withLayoutX, type PillX } from "./pillAnchor";

const start: PillX = { model: 20, mode: 20 };

test("a recycled event with a nulled nativeEvent does not throw", () => {
  const updater = withLayoutX({ nativeEvent: null }, "mode");

  expect(() => updater(start)).not.toThrow();
  expect(updater(start)).toEqual(start);
});

test("reads x synchronously, so recycling the event afterwards is harmless", () => {
  const event: { nativeEvent: { layout: { x: number } } | null } = {
    nativeEvent: { layout: { x: 132 } },
  };
  const updater = withLayoutX(event, "mode");

  // Exactly what React does between the handler and the updater running.
  event.nativeEvent = null;

  expect(updater(start)).toEqual({ model: 20, mode: 132 });
});

test("stores the offset under the pill that reported it", () => {
  expect(withLayoutX({ nativeEvent: { layout: { x: 88 } } }, "model")(start)).toEqual({
    model: 88,
    mode: 20,
  });
});

test("an unchanged offset returns the same object, so no re-render is queued", () => {
  const updater = withLayoutX({ nativeEvent: { layout: { x: 20 } } }, "model");

  expect(updater(start)).toBe(start);
});

test("missing, undefined and non-finite layouts are all ignored", () => {
  for (const event of [
    null,
    undefined,
    {},
    { nativeEvent: {} },
    { nativeEvent: { layout: {} } },
    { nativeEvent: { layout: { x: NaN } } },
  ]) {
    expect(withLayoutX(event, "mode")(start)).toBe(start);
  }
});
