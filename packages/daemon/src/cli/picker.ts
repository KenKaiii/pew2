/**
 * Choosing which agents to use, with arrow keys.
 *
 * `pew2 setup` finds every agent on PATH and offers all of them. That is the
 * right default but the wrong ending: an installed agent nobody uses still gets
 * spawned every time the phone connects, still holds memory, and still fills a
 * row in the drawer. Turning one off was possible only by remembering a command
 * and its id, which is not a thing anyone does.
 *
 * So setup asks. Arrows to move, space to toggle, enter to accept.
 *
 * Split into a reducer and a renderer with no I/O in either, because terminal
 * interaction is otherwise untestable: raw mode needs a real TTY, and a test
 * that drives one is testing the terminal rather than the behaviour. Here the
 * key handling and the drawing are both ordinary functions, and the imperative
 * shell around them is small enough to read in one go.
 */
import { PALETTE, styler, glyphs, type Glyphs, type Style } from "./ui.js";
import { rail, plural, type RenderOptions } from "./rail.js";

/** One row in the picker. */
export interface PickerItem {
  id: string;
  name: string;
  /**
   * Short parenthetical after the name, for agents that cannot be chosen.
   *
   * Inline rather than on its own line: a reason under every row doubled the
   * height of the list and pushed the agents you can actually use off the top
   * of a short terminal. "Codex (not installed)" says the same thing in the
   * space it deserves.
   */
  note?: string;
  /**
   * Installed and able to run.
   *
   * Agents that are not installed still appear — seeing what else exists is
   * half the value of this screen — but they cannot be selected, because
   * choosing one would promise something this machine cannot do.
   */
  selectable: boolean;
}

export interface PickerState {
  items: PickerItem[];
  /** Which row the cursor is on. */
  cursor: number;
  /** Ids that are turned on. */
  chosen: Set<string>;
  /** Set once the user accepts or cancels. */
  done?: "accepted" | "cancelled";
}

/** Start the picker with everything installed already turned on. */
export function initialState(items: PickerItem[], disabled: Set<string> = new Set()): PickerState {
  // Usable agents first, in the order they came in. The list is a thing to act
  // on, and interleaving agents that cannot be picked means arrowing past rows
  // that do nothing to reach the ones that do.
  const ordered = [
    ...items.filter((i) => i.selectable),
    ...items.filter((i) => !i.selectable),
  ];

  return {
    items: ordered,
    // Index 0 is a usable row whenever there is one, given the sort above.
    cursor: 0,
    chosen: new Set(
      ordered.filter((i) => i.selectable && !disabled.has(i.id)).map((i) => i.id),
    ),
  };
}

/** Move the cursor, skipping rows that cannot be chosen. */
function step(state: PickerState, delta: number): PickerState {
  const { items } = state;
  if (items.length === 0) return state;

  // Wraps, and gives up after a full loop so a list with nothing selectable
  // cannot spin forever.
  let next = state.cursor;
  for (let i = 0; i < items.length; i++) {
    next = (next + delta + items.length) % items.length;
    if (items[next]!.selectable) return { ...state, cursor: next };
  }
  return state;
}

function toggle(state: PickerState): PickerState {
  const item = state.items[state.cursor];
  if (!item?.selectable) return state;

  const chosen = new Set(state.chosen);
  if (chosen.has(item.id)) chosen.delete(item.id);
  else chosen.add(item.id);
  return { ...state, chosen };
}

/**
 * Apply one keypress.
 *
 * Returns the state unchanged for keys that mean nothing here, so a stray
 * escape sequence cannot corrupt the selection.
 */
export function reduce(state: PickerState, key: string): PickerState {
  if (state.done) return state;

  switch (key) {
    // Arrow keys arrive as escape sequences; j/k are here because anyone who
    // lives in a terminal will try them.
    case "\u001b[A":
    case "k":
      return step(state, -1);
    case "\u001b[B":
    case "j":
      return step(state, 1);
    case " ":
      return toggle(state);
    case "\r":
    case "\n":
      return { ...state, done: "accepted" };
    case "a":
      return { ...state, chosen: new Set(state.items.filter((i) => i.selectable).map((i) => i.id)) };
    case "n":
      return { ...state, chosen: new Set() };
    // `q`, not a bare escape. An arrow key *is* an escape sequence, and a
    // terminal under load or over SSH can deliver the escape byte in one chunk
    // and `[A` in the next \u2014 so treating a lone escape as "cancel" means a
    // laggy arrow press silently throws away the user's selection.
    case "q":
      return { ...state, done: "cancelled" };
    default:
      return state;
  }
}

/** The whole screen, as lines. */
export function render(state: PickerState, options: RenderOptions = {}): string[] {
  const s: Style = options.style ?? styler();
  const g: Glyphs = options.glyph ?? glyphs();
  const r = rail(options);

  const out = [...r.intro("pew2 agents", "choose what your phone can use")];
  out.push(...r.step("Found on this computer", plural(state.items.length, "agent")));

  state.items.forEach((item, index) => {
    const here = index === state.cursor;
    const on = state.chosen.has(item.id);

    // The cursor is a caret in the margin rather than a highlighted row: a
    // background colour is unreadable on terminals whose theme already uses it.
    const caret = here ? s.hex(PALETTE.accent, g.unicode ? "\u276f" : ">") : " ";
    const box = !item.selectable
      ? s.hex(PALETTE.faint, g.unicode ? "\u00b7" : "-")
      : on
        ? s.hex(PALETTE.success, g.tick)
        : s.hex(PALETTE.faint, g.unicode ? "\u25cb" : "o");

    const name = !item.selectable
      ? s.hex(PALETTE.faint, item.name)
      : here
        ? s.bold(item.name)
        : item.name;

    const note = item.note ? s.hex(PALETTE.faint, ` (${item.note})`) : "";
    out.push(r.line(`${caret} ${box} ${name}${note}`));
  });

  out.push(r.bar());
  out.push(
    r.line(
      [
        `${s.bold(g.unicode ? "\u2191\u2193" : "up/down")} ${s.hex(PALETTE.faint, "move")}`,
        `${s.bold("space")} ${s.hex(PALETTE.faint, "toggle")}`,
        `${s.bold("a")} ${s.hex(PALETTE.faint, "all")}`,
        `${s.bold("n")} ${s.hex(PALETTE.faint, "none")}`,
        `${s.bold("enter")} ${s.hex(PALETTE.faint, "done")}`,
      ].join("   "),
    ),
  );
  return out;
}

/** The closing line, once a choice has been made. */
export function summary(state: PickerState, options: RenderOptions = {}): string[] {
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  const r = rail(options);

  if (state.done === "cancelled") {
    return r.outro(s.hex(PALETTE.faint, "Left as it was."));
  }

  const count = state.chosen.size;
  if (count === 0) {
    // Allowed, but said plainly: a phone with no agents is not obviously an
    // intentional state, and the way back should be on screen.
    return r.outro(
      `${s.hex(PALETTE.warning, g.dot)} ${s.bold("No agents chosen.")} ${s.hex(PALETTE.faint, "Run pew2 setup again to pick some.")}`,
    );
  }
  return r.outro(
    `${s.hex(PALETTE.success, g.tick)} ${s.bold(`${plural(count, "agent")} on your phone.`)}`,
  );
}
