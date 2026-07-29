/**
 * Regression net for top-bar slot assignment.
 *
 * The bug this exists for: `/mode/` also matches "model", so an agent whose only
 * selector was the model filled both the model pill and the mode pill, giving
 * two identical dropdowns.
 */
import { test, expect } from "bun:test";
import { summarise } from "./configSlots";
import type { ConfigOption } from "../useDaemon";

function select(
  partial: Partial<ConfigOption> & Pick<ConfigOption, "id" | "name">,
): ConfigOption {
  return {
    type: "select",
    currentValue: "a",
    options: [
      { value: "a", name: "A" },
      { value: "b", name: "B" },
    ],
    ...partial,
  };
}

test("a lone model selector does not also claim the mode pill", () => {
  const { model, mode } = summarise([select({ id: "model", name: "Model" })]);

  expect(model?.id).toBe("model");
  expect(mode).toBeUndefined();
});

test("an uncategorised model selector still does not claim the mode pill", () => {
  const { model, mode } = summarise([
    select({ id: "model_name", name: "Model", category: undefined }),
  ]);

  expect(model?.id).toBe("model_name");
  expect(mode).toBeUndefined();
});

test("model and mode selectors resolve to distinct options", () => {
  const { model, mode } = summarise([
    select({ id: "model", name: "Model", category: "model" }),
    select({ id: "mode", name: "Mode", category: "mode", currentValue: "bypass" }),
  ]);

  expect(model?.id).toBe("model");
  expect(mode?.id).toBe("mode");
  expect(model).not.toBe(mode);
});

test("distinct slots without categories, as an agent that sets none reports", () => {
  const { model, mode, level } = summarise([
    select({ id: "model", name: "Model" }),
    select({ id: "permission_mode", name: "Permission mode" }),
    select({ id: "thinking", name: "Thinking" }),
  ]);

  expect(model?.id).toBe("model");
  expect(mode?.id).toBe("permission_mode");
  expect(level?.id).toBe("thinking");
});

test("non-select and empty options are never slotted", () => {
  const { model, mode, level } = summarise([
    { id: "model", name: "Model", type: "boolean", currentValue: true },
    { id: "mode", name: "Mode", type: "select", currentValue: "a", options: [] },
  ]);

  expect(model).toBeUndefined();
  expect(mode).toBeUndefined();
  expect(level).toBeUndefined();
});
