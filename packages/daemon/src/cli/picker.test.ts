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
  item({ id: "codex", name: "Codex", selectable: false, note: "not installed" }),
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

test("usable agents come first, whatever order they arrived in", () => {
  // The list is a thing to act on. Interleaving agents that cannot be picked
  // means arrowing past rows that do nothing to reach the ones that do.
  const state = initialState(items);
  expect(state.items.map((i) => i.id)).toEqual(["claude-code", "opencode", "goose", "codex"]);
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

test("enter accepts and q backs out", () => {
  expect(reduce(initialState(items), "\r").done).toBe("accepted");
  expect(reduce(initialState(items), "q").done).toBe("cancelled");
});

test("a lone escape byte does not throw away the selection", () => {
  // An arrow key is an escape sequence, and a terminal under load or over SSH
  // can deliver the escape byte in one chunk and `[A` in the next. Cancelling
  // on a bare escape meant a laggy arrow press discarded everything the user
  // had chosen.
  const state = reduce(initialState(items), "\u001b");
  expect(state.done).toBeUndefined();
  expect(state.chosen.size).toBe(3);
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
  expect(reduce(done, "q")).toBe(done);
});

test("the screen shows state, cursor and the keys that work", () => {
  const text = render(initialState(items), plain).map(stripAnsi).join("\n");

  expect(text).toContain("Claude Code");
  expect(text).toContain("✓");
  expect(text).toContain("❯");
  expect(text).toContain("space");
  expect(text).toContain("toggle");
});

test("an unusable agent says why on its own row, not a second one", () => {
  // Seeing what else exists is half the value of the screen; it just cannot be
  // chosen. A reason under every row doubled the height of the list and pushed
  // the agents you can actually use off the top of a short terminal.
  const lines = render(initialState(items), plain).map(stripAnsi);
  const row = lines.find((l) => l.includes("Codex"))!;

  expect(row).toContain("Codex (not installed)");
  // Exactly one line mentions it.
  expect(lines.filter((l) => l.includes("not installed"))).toHaveLength(1);
});

test("a usable agent carries no parenthetical at all", () => {
  // Nothing stands between it and being picked, so there is nothing to say.
  const lines = render(initialState(items), plain).map(stripAnsi);
  expect(lines.find((l) => l.includes("Claude Code"))).not.toContain("(");
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
  const state = reduce(initialState(items), "q");
  expect(stripAnsi(summary(state, plain).join("\n"))).toContain("Left as it was");
});

test("accepting reports how many are on", () => {
  const state = reduce(initialState(items), "\r");
  expect(stripAnsi(summary(state, plain).join("\n"))).toContain("3 agents");
});
