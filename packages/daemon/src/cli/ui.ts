/**
 * Terminal primitives shared by the CLI's presentational commands.
 *
 * Everything here degrades rather than breaks. A pipe, a CI log, `NO_COLOR`, a
 * terminal without truecolour and a terminal without a Unicode font are all
 * normal ways for this output to be read, and a "pretty" CLI that only looks
 * right in one of them is a broken CLI. So capability is detected once, and each
 * helper has a defined fallback:
 *
 *   colour    truecolour -> 256-colour -> nothing
 *   glyphs    box drawing + braille -> ASCII
 *   motion    animated spinner -> a single static line
 *
 * The rule throughout: colour and glyphs may carry *emphasis*, never meaning.
 * Anything the user must know is in the words, so stripping every escape leaves
 * output that still reads correctly.
 */
import { spawn } from "node:child_process";

/**
 * Colour is off when piped, when `NO_COLOR` is set (the de-facto standard) or
 * when `TERM=dumb`. `FORCE_COLOR` overrides all of it, which is what lets the
 * tests assert on styled output without a TTY.
 */
export function colorLevel(
  env: NodeJS.ProcessEnv = process.env,
  isTty: boolean = Boolean(process.stdout.isTTY),
): 0 | 1 | 2 {
  if (env.FORCE_COLOR === "0") return 0;
  const forced = env.FORCE_COLOR !== undefined && env.FORCE_COLOR !== "";
  if (!forced) {
    if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
    if (env.TERM === "dumb") return 0;
    if (!isTty) return 0;
  }
  if (/truecolor|24bit/i.test(env.COLORTERM ?? "")) return 2;
  if (forced && env.FORCE_COLOR !== "1") return 2;
  return 1;
}

/**
 * Unicode is assumed everywhere except the Windows console, which historically
 * renders box drawing and braille as replacement boxes. `PEW2_ASCII=1` forces
 * the fallback, so the degraded path is testable and escapable.
 */
export function unicodeOk(env: NodeJS.ProcessEnv = process.env): boolean {
  if (env.PEW2_ASCII === "1") return false;
  if (process.platform !== "win32") return true;
  return env.WT_SESSION !== undefined || env.TERM_PROGRAM === "vscode";
}

export interface Style {
  /** Foreground colour from a hex string, downgraded or dropped as needed. */
  hex: (hex: string, text: string) => string;
  bold: (text: string) => string;
  dim: (text: string) => string;
  /** Underline, used only for values worth selecting with the mouse. */
  under: (text: string) => string;
  enabled: boolean;
}

const RESET = "\x1b[0m";

/** `#rrggbb` -> the nearest xterm-256 index, for terminals without truecolour. */
export function to256(hex: string): number {
  const [r, g, b] = rgb(hex);
  // The 6x6x6 colour cube starts at index 16. Greys have their own ramp, and
  // using it for near-greys avoids the cube's visible colour cast.
  if (Math.max(r, g, b) - Math.min(r, g, b) < 8) {
    const level = Math.round(((r + g + b) / 3 / 255) * 23);
    return 232 + level;
  }
  const axis = (v: number) => Math.round((v / 255) * 5);
  return 16 + 36 * axis(r) + 6 * axis(g) + axis(b);
}

function rgb(hex: string): [number, number, number] {
  const value = Number.parseInt(hex.replace("#", ""), 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

export function styler(level: 0 | 1 | 2 = colorLevel()): Style {
  if (level === 0) {
    const plain = (text: string) => text;
    return { hex: (_hex, text) => text, bold: plain, dim: plain, under: plain, enabled: false };
  }
  const wrap = (open: string) => (text: string) => `${open}${text}${RESET}`;
  return {
    hex: (hex, text) =>
      level === 2
        ? `\x1b[38;2;${rgb(hex).join(";")}m${text}${RESET}`
        : `\x1b[38;5;${to256(hex)}m${text}${RESET}`,
    bold: wrap("\x1b[1m"),
    dim: wrap("\x1b[2m"),
    under: wrap("\x1b[4m"),
    enabled: true,
  };
}

/** The app's palette, so the terminal and the phone are recognisably one product. */
export const PALETTE = {
  accent: "#d97757",
  success: "#3fb950",
  danger: "#f85149",
  warning: "#d9a441",
  faint: "#6d6d73",
} as const;

export interface Glyphs {
  /**
   * Whether this set is the Unicode one. Carried explicitly so callers can
   * branch on capability rather than comparing against a glyph's current value,
   * which silently flips the branch the day a glyph is changed.
   */
  unicode: boolean;
  tick: string;
  cross: string;
  warn: string;
  dot: string;
  rule: string;
  arrow: string;
  spinner: string[];
}

export function glyphs(unicode: boolean = unicodeOk()): Glyphs {
  return unicode
    ? {
        unicode: true,
        tick: "✓",
        cross: "✗",
        warn: "!",
        dot: "·",
        rule: "─",
        arrow: "→",
        // Braille dots read as one smoothly rotating shape at 80ms, where
        // ASCII spinners read as four separate characters flickering.
        spinner: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
      }
    : {
        unicode: false,
        tick: "+",
        cross: "x",
        warn: "!",
        dot: "-",
        rule: "-",
        arrow: "->",
        spinner: ["|", "/", "-", "\\"],
      };
}

const ANSI = /\x1b\[[0-9;]*m/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

/**
 * Printable width, in terminal cells.
 *
 * Escapes take no space, and the half-block used by the QR is a normal
 * single-width character, so counting code points after stripping escapes is
 * correct for everything this CLI prints. Surrogate pairs are handled by
 * iterating code points rather than UTF-16 units.
 */
export function width(text: string): number {
  return [...stripAnsi(text)].length;
}

/**
 * How wide the output may be.
 *
 * `stream.columns` is only set when stdout is a terminal, so piping into `less`
 * or a file loses it. `COLUMNS` is the conventional way to say how wide the
 * result should be anyway, and honouring it is what makes the narrow layout
 * testable without allocating a pty.
 */
export function terminalWidth(
  stream: { columns?: number } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): number {
  if (stream.columns && stream.columns > 0) return stream.columns;
  const declared = Number(env.COLUMNS);
  if (Number.isFinite(declared) && declared > 0) return declared;
  return 80;
}

/** Pad a styled string to `target` cells, ignoring escapes. */
export function padEnd(text: string, target: number): string {
  return text + " ".repeat(Math.max(0, target - width(text)));
}

/**
 * Truncate to `max` cells with an ellipsis, escape-aware only to the extent
 * that callers pass plain text. Used for hosts and paths, never for secrets.
 */
export function truncate(text: string, max: number, ellipsis = "…"): string {
  const chars = [...text];
  if (chars.length <= max) return text;
  return chars.slice(0, Math.max(0, max - ellipsis.length)).join("") + ellipsis;
}

/**
 * Middle-elide a secret so it can be recognised without being readable over a
 * shoulder or in a screen recording. Short values are returned whole: eliding
 * them would reveal proportionally more than it hides.
 */
export function fingerprint(secret: string, head = 6, tail = 4, ellipsis = "…"): string {
  if (secret.length <= head + tail + ellipsis.length) return secret;
  return `${secret.slice(0, head)}${ellipsis}${secret.slice(-tail)}`;
}

/** "just now", "3 hours ago", "5 days ago" — enough to spot a stale token. */
export function relativeAge(iso: string, now: number = Date.now()): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown age";
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  const plural = (value: number, unit: string) => `${value} ${unit}${value === 1 ? "" : "s"} ago`;

  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(Math.max(1, minutes), "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return plural(hours, "hour");
  const days = Math.round(hours / 24);
  if (days < 7) return plural(days, "day");
  if (days < 30) return plural(Math.round(days / 7), "week");
  if (days < 365) return plural(Math.round(days / 30), "month");
  return plural(Math.round(days / 365), "year");
}

/**
 * Copy to the system clipboard. Never throws and never blocks for long: this is
 * a convenience, and a machine without a clipboard tool (a headless server, a
 * container) must still complete the command.
 */
export function copyToClipboard(text: string): Promise<boolean> {
  const candidates: [string, string[]][] =
    process.platform === "darwin"
      ? [["pbcopy", []]]
      : process.platform === "win32"
        ? [["clip", []]]
        : [
            ["wl-copy", []],
            ["xclip", ["-selection", "clipboard"]],
            ["xsel", ["--clipboard", "--input"]],
          ];

  const attempt = (index: number): Promise<boolean> => {
    const candidate = candidates[index];
    if (!candidate) return Promise.resolve(false);
    const [command, args] = candidate;
    return new Promise((resolve) => {
      let settled = false;
      const done = (value: boolean) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      try {
        const child = spawn(command, args, { stdio: ["pipe", "ignore", "ignore"] });
        const timer = setTimeout(() => {
          child.kill();
          done(false);
        }, 2_000);
        timer.unref?.();
        child.on("error", () => {
          clearTimeout(timer);
          void attempt(index + 1).then(done);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          if (code === 0) done(true);
          else void attempt(index + 1).then(done);
        });
        child.stdin.end(text);
      } catch {
        void attempt(index + 1).then(done);
      }
    });
  };

  return attempt(0);
}

/** Hide and restore the cursor around animated output, including on Ctrl-C. */
function hideCursor(stream: NodeJS.WriteStream = process.stdout): () => void {
  if (!stream.isTTY) return () => {};
  stream.write("\x1b[?25l");
  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    stream.write("\x1b[?25h");
  };
  process.once("exit", restore);
  return restore;
}

export interface StatusLine {
  /** Replace the line's text, keeping the spinner running. */
  update: (text: string) => void;
  /** Stop, and leave `final` on screen permanently. */
  stop: (final?: string) => void;
}

/**
 * A single self-rewriting line.
 *
 * Only the last line is ever redrawn, and only when stdout is a TTY. Piped
 * output gets each state printed once instead: a log full of carriage returns
 * and escape codes is worse than no animation at all.
 */
export function statusLine(
  label: string,
  options: {
    stream?: NodeJS.WriteStream;
    frames?: string[];
    intervalMs?: number;
    /**
     * Literal prefix for the live line, so it sits in the same column as the
     * rest of the screen.
     *
     * A string rather than a space count: the rail is a coloured glyph, not
     * whitespace, and every screen that uses this now draws on the rail.
     */
    prefix?: string;
  } = {},
): StatusLine {
  const stream = options.stream ?? process.stdout;
  const frames = options.frames ?? glyphs().spinner;
  const interval = options.intervalMs ?? 80;
  const pad = options.prefix ?? "";
  const style = styler();
  let text = label;
  let frame = 0;
  let stopped = false;

  if (!stream.isTTY) {
    stream.write(`${pad}${text}\n`);
    return {
      update: (next) => {
        if (stopped || next === text) return;
        text = next;
        stream.write(`${pad}${next}\n`);
      },
      stop: (final) => {
        if (stopped) return;
        stopped = true;
        if (final !== undefined) stream.write(`${final}\n`);
      },
    };
  }

  const restoreCursor = hideCursor(stream);
  const draw = () => {
    // \r then erase-to-end, rather than a full line clear: it leaves the line
    // untouched on terminals that do not support the erase sequence.
    stream.write(
      `\r\x1b[2K${pad}${style.hex(PALETTE.accent, frames[frame % frames.length]!)} ${text}`,
    );
    frame++;
  };

  draw();
  const timer = setInterval(draw, interval);
  timer.unref?.();

  return {
    update: (next) => {
      if (stopped) return;
      text = next;
    },
    stop: (final) => {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      stream.write("\r\x1b[2K");
      if (final !== undefined) stream.write(`${final}\n`);
      restoreCursor();
    },
  };
}

/**
 * Listen for single keypresses while something else is happening.
 *
 * Raw mode is entered only for a real TTY and is always restored, including on
 * Ctrl-C — a CLI that leaves the terminal in raw mode on exit has broken the
 * user's shell, which is far worse than lacking a shortcut. Ctrl-C and Ctrl-D
 * are handled here because raw mode suppresses the kernel's own handling.
 */
export function onKeypress(
  handler: (key: string) => void,
  options: { stream?: NodeJS.ReadStream; onAbort?: () => void } = {},
): () => void {
  const stream = options.stream ?? process.stdin;
  if (!stream.isTTY || typeof stream.setRawMode !== "function") return () => {};

  const listener = (chunk: Buffer) => {
    const key = chunk.toString("utf8");
    if (key === "\u0003" || key === "\u0004") {
      cleanup();
      options.onAbort?.();
      return;
    }
    handler(key);
  };

  let active = true;
  const cleanup = () => {
    if (!active) return;
    active = false;
    stream.off("data", listener);
    try {
      stream.setRawMode(false);
    } catch {
      // The terminal went away; there is nothing left to restore.
    }
    stream.pause();
    process.off("exit", cleanup);
  };

  stream.setRawMode(true);
  stream.resume();
  stream.on("data", listener);
  process.once("exit", cleanup);
  return cleanup;
}
