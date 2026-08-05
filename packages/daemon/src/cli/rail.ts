/**
 * The chrome every pew2 command is drawn with.
 *
 * Five commands used to look like five tools: `setup` and `providers list` drew
 * a rail, `pair` drew a centred block under a rule, `doctor` and `registry sync`
 * printed bare ticks in the order things happened. Same binary, three different
 * visual languages, and no way to tell at a glance which program you were in.
 *
 * So the rail lives here now rather than inside any one screen, and every
 * command opens with a mark, hangs its sections off the same pipe, and closes
 * with a single line that says what happened. Anything shared between screens
 * belongs in this file; anything specific to one screen does not.
 */
import { PALETTE, styler, glyphs, terminalWidth, type Glyphs, type Style } from "./ui.js";

export interface RenderOptions {
  style?: Style;
  glyph?: Glyphs;
  /** Terminal width. Defaults to the real one, or 80 when it is not a terminal. */
  columns?: number;
}

/**
 * Room for a wrapped detail line.
 *
 * Subtracts the rail prefix and the two-space hang, then clamps: a very narrow
 * terminal should still wrap somewhere sensible rather than one word per line,
 * and a very wide one should not stretch prose to 200 characters.
 */
export function detailWidth(options: RenderOptions): number {
  const columns = options.columns ?? terminalWidth();
  return Math.max(32, Math.min(96, columns - 6));
}

/** The pieces of the rail a screen draws with. */
export interface Rail {
  /** Opens the flow. */
  intro: (title: string, subtitle?: string) => string[];
  /** A section heading hanging off the rail. */
  step: (title: string, note?: string) => string[];
  /** A line inside the current section. */
  line: (text: string) => string;
  /** An empty rail segment, for breathing room. */
  bar: () => string;
  /** Closes the flow. */
  outro: (text: string) => string[];
}

/**
 * The vertical rail.
 *
 * Borrowed from the visual language `@clack/prompts` popularised, because it
 * solves the actual problem: it makes a sequence of steps read as one connected
 * flow rather than as unrelated blocks of text scrolling past. Implemented here
 * rather than taken as a dependency, since this ships inside a compiled binary
 * and `ui.ts` already degrades colour and glyphs correctly for terminals that
 * cannot render either.
 */
export function rail(options: RenderOptions = {}): Rail {
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  const unicode = g.unicode;

  const pipe = s.hex(PALETTE.faint, unicode ? "│" : "|");
  const open = s.hex(PALETTE.accent, unicode ? "◆" : "*");
  const dot = s.hex(PALETTE.faint, unicode ? "◇" : "o");
  const end = s.hex(PALETTE.accent, unicode ? "└" : "`");

  return {
    intro: (title, subtitle) => [
      "",
      `${open}  ${s.bold(title)}`,
      ...(subtitle ? [`${pipe}  ${s.hex(PALETTE.faint, subtitle)}`] : []),
    ],
    step: (title, note) => [
      pipe,
      `${dot}  ${s.bold(title)}${note ? s.hex(PALETTE.faint, `  ${note}`) : ""}`,
      pipe,
    ],
    line: (text) => `${pipe}  ${text}`,
    bar: () => pipe,
    outro: (text) => [pipe, `${end}  ${text}`, ""],
  };
}

/** `1 agent` / `2 agents`. Pluralises the last word, so pass a noun. */
export function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/**
 * An agent's message, wrapped rather than cut.
 *
 * These messages are the instruction — "Configuration value not found:
 * GOOSE_PROVIDER" names the exact thing to set, and it sits at the *end* of the
 * sentence. Truncating removes the only part worth reading and leaves an
 * ellipsis where the answer was.
 *
 * Only the first line of a multi-line error is kept: agents sometimes attach a
 * stack, and that belongs in `pew2 providers verify`, not on a summary screen.
 */
export function wrapDetail(text: string, width: number): string[] {
  const line = text.split("\n")[0]!.trim();
  if (line.length <= width) return [line];

  const out: string[] = [];
  let current = "";
  for (const word of line.split(/\s+/)) {
    if (!current) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current += ` ${word}`;
    } else {
      out.push(current);
      current = word;
    }
    // A single unbroken token longer than the line — a path, a URL — is left
    // whole and allowed to overflow, because breaking it makes it
    // uncopyable and that is worse than a wrapped terminal line.
  }
  if (current) out.push(current);
  return out;
}
