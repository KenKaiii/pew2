/**
 * The imperative half of the agent picker: keys in, redraw out.
 *
 * Everything that decides anything lives in `picker.ts` as plain functions.
 * This file only owns the parts that cannot be tested without a real terminal —
 * raw mode, cursor movement, and redrawing in place — and is kept small enough
 * to read in one sitting for that reason.
 */
import { onKeypress, colorLevel, styler, glyphs, unicodeOk, terminalWidth } from "./ui.js";
import { initialState, reduce, render, summary, type PickerItem, type PickerState } from "./picker.js";

export interface PickOptions {
  /** Already-disabled agents, so reopening setup shows the last choice. */
  disabled?: Set<string>;
  stream?: NodeJS.ReadStream;
  write?: (text: string) => void;
  /** Overridable so a test can observe the exit instead of taking it. */
  exit?: (code: number) => never;
}

/**
 * Ask which agents to use.
 *
 * Resolves to the chosen ids, or undefined when the user backs out — which is
 * not the same as choosing none, and callers must not treat it as such.
 */
export async function pickAgents(
  items: PickerItem[],
  options: PickOptions = {},
): Promise<Set<string> | undefined> {
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const view = {
    style: styler(colorLevel()),
    glyph: glyphs(unicodeOk()),
    columns: terminalWidth(),
  };

  let state = initialState(items, options.disabled);
  let drawnLines = 0;

  const draw = () => {
    // Move up over the previous frame and clear each line, so the list updates
    // in place instead of scrolling a new copy past on every keypress.
    if (drawnLines > 0) write(`\u001b[${drawnLines}A\u001b[0J`);
    const lines = render(state, view);
    write(`${lines.join("\n")}\n`);
    drawnLines = lines.length;
  };

  // Hidden while the list is live: a cursor parked mid-list looks like a
  // text field, and it flickers on every redraw.
  write("\u001b[?25l");
  draw();

  try {
    await new Promise<void>((resolve) => {
      const stop = onKeypress(
        (key) => {
          const next = reduce(state, key);
          if (next === state) return;
          state = next;
          if (state.done) {
            stop();
            resolve();
            return;
          }
          draw();
        },
        {
          stream: options.stream,
          onAbort: () => {
            // Ctrl-C means stop the program, not "skip this question". Treating
            // it as a cancel left setup carrying on to print its closing
            // summary, which reads as the interrupt having been ignored.
            //
            // The cursor is restored first: `onKeypress` has already put the
            // terminal back, and leaving the cursor hidden would outlive the
            // process and break the user's shell.
            write("\u001b[?25h");
            (options.exit ?? process.exit.bind(process))(130);
            resolve();
          },
        },
      );

      // No TTY: nothing can be typed, so the defaults stand rather than the
      // process hanging on input that will never arrive. This is the path a
      // script or a CI run takes.
      if (!(options.stream ?? process.stdin).isTTY) {
        stop();
        state = { ...state, done: "accepted" };
        resolve();
      }
    });
  } finally {
    write("\u001b[?25h");
  }

  for (const line of summary(state, view)) write(`${line}\n`);
  return state.done === "cancelled" ? undefined : state.chosen;
}

export type { PickerItem, PickerState };
