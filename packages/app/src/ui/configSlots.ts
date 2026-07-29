/**
 * Which advertised selector goes in which top-bar pill.
 *
 * Pure and free of react-native imports so it can be unit tested directly: this
 * is the logic that decides what the user can switch, and a regression here is
 * invisible in typecheck but very visible on screen.
 */
import type { ConfigOption } from "../useDaemon";

/**
 * Slot a selector into the top bar.
 *
 * The category is authoritative when the agent sets one. Claude Code advertises
 * a permission `mode` alongside its model, and matching on name alone would let
 * that mode take the model pill and hide the model entirely.
 */
function slot(
  options: ConfigOption[],
  category: string,
  pattern: RegExp,
): ConfigOption | undefined {
  return (
    options.find((o) => o.category === category) ??
    options.find(
      (o) => !o.category && pattern.test(`${o.id} ${o.name}`.replace(/_/g, " ")),
    )
  );
}

/** The selectors shown in the top bar: model, mode, and thinking level. */
export function summarise(options: ConfigOption[]): {
  model?: ConfigOption;
  mode?: ConfigOption;
  level?: ConfigOption;
} {
  const selectable = options.filter((o) => o.type === "select" && o.options?.length);
  // \b matters: an unanchored /mode/ also matches "model", which put the model
  // selector behind both pills.
  const mode = slot(selectable, "mode", /\bmodes?\b|permission/i);
  const level = slot(
    selectable,
    "thought_level",
    /\b(think|thinking|reason|reasoning|effort)\b/i,
  );
  // Only the model slot falls back to "whatever is left", so an agent that sets
  // no categories still gets one usable pill.
  const model =
    selectable.find((o) => o.category === "model") ??
    selectable.find(
      (o) => o !== mode && o !== level && /model/i.test(`${o.id} ${o.name}`),
    ) ??
    selectable.find((o) => o !== mode && o !== level);

  return { model, mode, level };
}

export function valueName(option?: ConfigOption): string | undefined {
  if (!option) return undefined;
  const match = option.options?.find((v) => v.value === option.currentValue);
  return match?.name ?? String(option.currentValue);
}
