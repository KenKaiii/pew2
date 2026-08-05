import { test, expect } from "bun:test";
import { initialState, reduce, render, summary, type PickerItem } from "./picker.js";
import { stripAnsi, styler, glyphs } from "./ui.js";

const plain = { style: styler(0), glyph: glyphs(true), columns: 80 };

const item = (over: Partial<PickerItem> & { id: string }): PickerItem => ({
  name: over.id,
  selectable: true,
  ...over,
});

const items: PickerItem[] = [
  item({ id: "claude-code", name: "Claude Code" }),
  item({ id: "opencode", name: "OpenCode" }),
  item({ id: "codex", name: "Codex", selectable: false, detail: "not installed" }),
  item({ id: "goose", name: "goose" }),
];

const UP = "\u001b[A";
const DOWN = "\u001b[B";

test("everything installed starts turned on", () => {
  // Setup already offered all of these, so the picker opening with them off
  // would look like it had broken something.
  const state = initialState(items);
  expect(state.chosen).toEqual(new Set(["claude-code", "opencode", "goose"]));
});

test("an agent turned off last time stays off", () => {
  // Reopening setup must not silently undo a choice already made.
  const state = initialState(items, new Set(["opencode"]));
  expect(state.chosen.has("opencode")).toBe(false);
  expect(state.chosen.has("claude-code")).toBe(true);
});

test("space toggles the agent under the cursor", () => {
  let state = initialState(items);
  state = reduce(state, " ");
  expect(state.chosen.has("claude-code")).toBe(false);

  state = reduce(state, " ");
  expect(state.chosen.has("claude-code")).toBe(true);
});

test("arrows move, and skip agents that cannot be chosen", () => {
  // Codex is not installed. Landing on it would offer a choice that does
  // nothing, which reads as the key being broken.
  let state = initialState(items);
  expect(state.items[state.cursor]!.id).toBe("claude-code");

  state = reduce(state, DOWN);
  expect(state.items[state.cursor]!.id).toBe("opencode");

  state = reduce(state, DOWN);
  expect(state.items[state.cursor]!.id).toBe("goose");
});

test("the cursor wraps at both ends", () => {
  let state = initialState(items);
  state = reduce(state, UP);
  expect(state.items[state.cursor]!.id).toBe("goose");

  state = reduce(state, DOWN);
  expect(state.items[state.cursor]!.id).toBe("claude-code");
});

test("j and k move too", () => {
  // Anyone who lives in a terminal will try them before reading the hint.
  let state = initialState(items);
  state = reduce(state, "j");
  expect(state.items[state.cursor]!.id).toBe("opencode");
  state = reduce(state, "k");
  expect(state.items[state.cursor]!.id).toBe("claude-code");
});

test("a list with nothing selectable does not hang", () => {
  // Every row unusable means the cursor search can find no home. Looping
  // forever here would freeze the terminal in raw mode, which takes the user's
  // shell with it.
  const none = [item({ id: "a", selectable: false }), item({ id: "b", selectable: false })];
  const state = reduce(initialState(none), DOWN);
  expect(state.cursor).toBe(0);
});

test("an unselectable agent cannot be toggled on", () => {
  // It is not installed. Ticking it would promise something this machine
  // cannot do.
  const only = [item({ id: "codex", selectable: false })];
  const state = reduce(initialState(only), " ");
  expect(state.chosen.size).toBe(0);
});

test("a and n select all and none, without touching the unusable ones", () => {
  let state = reduce(initialState(items), "n");
  expect(state.chosen.size).toBe(0);

  state = reduce(state, "a");
  expect(state.chosen).toEqual(new Set(["claude-code", "opencode", "goose"]));
  expect(state.chosen.has("codex")).toBe(false);
});

test("enter accepts and escape backs out", () => {
  expect(reduce(initialState(items), "\r").done).toBe("accepted");
  expect(reduce(initialState(items), "\u001b").done).toBe("cancelled");
});

test("keys that mean nothing here leave the selection alone", () => {
  // A stray escape sequence from a mouse or a resize must not toggle anything.
  const before = initialState(items);
  const after = reduce(before, "\u001b[200~");
  expect(after).toBe(before);
});

test("nothing responds once a choice has been made", () => {
  // The keypress listener is torn down asynchronously, so a fast second press
  // can still arrive after enter.
  const done = reduce(initialState(items), "\r");
  expect(reduce(done, " ")).toBe(done);
  expect(reduce(done, "\u001b")).toBe(done);
});

test("the screen shows state, cursor and the keys that work", () => {
  const text = render(initialState(items), plain).map(stripAnsi).join("\n");

  expect(text).toContain("Claude Code");
  expect(text).toContain("✓");
  expect(text).toContain("❯");
  expect(text).toContain("space");
  expect(text).toContain("toggle");
});

test("an unusable agent is shown, dimmed, with the reason", () => {
  // Seeing what else exists is half the value of the screen; it just cannot
  // be chosen.
  const text = render(initialState(items), plain).map(stripAnsi).join("\n");
  expect(text).toContain("Codex");
  expect(text).toContain("not installed");
});

test("every line stays on the rail", () => {
  const lines = render(initialState(items), plain)
    .map(stripAnsi)
    .filter((l) => l !== "");
  expect(lines.every((l) => /^[│◇◆└]/.test(l))).toBe(true);
});

test("the screen degrades to ASCII", () => {
  const ascii = { style: styler(0), glyph: glyphs(false), columns: 80 };
  const text = stripAnsi(render(initialState(items), ascii).join("\n"));
  expect(/[^\x00-\x7F]/.test(text)).toBe(false);
});

test("choosing none says so, rather than closing silently", () => {
  // A phone with no agents is not obviously deliberate, so the way back is on
  // screen.
  let state = reduce(initialState(items), "n");
  state = reduce(state, "\r");
  const text = stripAnsi(summary(state, plain).join("\n"));

  expect(text).toContain("No agents chosen");
  expect(text).toContain("pew2 setup");
});

test("backing out is not reported as a change", () => {
  const state = reduce(initialState(items), "\u001b");
  expect(stripAnsi(summary(state, plain).join("\n"))).toContain("Left as it was");
});

test("accepting reports how many are on", () => {
  const state = reduce(initialState(items), "\r");
  expect(stripAnsi(summary(state, plain).join("\n"))).toContain("3 agents");
});
