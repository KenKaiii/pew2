/**
 * The layout of `pew2 pair`, as pure functions.
 *
 * Rendering is separated from doing so the screen can be tested without a
 * daemon, a relay, a phone or a terminal. Every function here takes plain data
 * and returns lines of text; nothing reads the environment, opens a socket or
 * writes to stdout.
 *
 * The screen answers three questions, in the order a user asks them:
 *
 *   1. What do I do?          the QR, and two numbered steps
 *   2. Will it work?          reach, daemon, relay — checked, not claimed
 *   3. Did it work?           a live line that resolves when the phone connects
 *
 * Facts are never asserted without having been verified. "Works from anywhere"
 * printed next to an unreachable relay is worse than no status line, because it
 * sends the user to debug their phone instead of their relay.
 */
import {
  PALETTE,
  fingerprint,
  glyphs,
  padEnd,
  relativeAge,
  styler,
  truncate,
  width,
  type Glyphs,
  type Style,
} from "./ui.js";

export type Reach = "anywhere" | "local" | "unreachable";

export interface PairView {
  url: string;
  token: string;
  createdAt: string;
  reach: Reach;
  /** Relay origin and whether it answered a health check, when configured. */
  relay?: { url: string; healthy: boolean | null };
  /** LAN addresses, best first. Only meaningful without a relay. */
  addresses: string[];
  port: number;
  daemonRunning: boolean;
  rotated: boolean;
}

export interface RenderOptions {
  style?: Style;
  glyph?: Glyphs;
  columns?: number;
  now?: number;
}

/** Two spaces of gutter on every line, so nothing sits flush against the edge. */
const GUTTER = "  ";
/** Label column for the status rows. Wide enough for the longest label. */
const LABEL = 8;

/**
 * Indent a pre-rendered block, such as the QR.
 *
 * The QR sets its own colours per cell, so the indent must be plain spaces
 * outside the escapes — prefixing a styled string would bleed the terminal's
 * background into the quiet zone and can stop the code scanning.
 */
export function indent(block: string, spaces: number): string {
  const pad = " ".repeat(spaces);
  return block
    .split("\n")
    .map((line) => `${pad}${line}`)
    .join("\n");
}

/**
 * Centre a block within `columns`, never negative and never past the left edge.
 * Falls back to the standard gutter when the block is wider than the terminal,
 * which is the case for a QR in a narrow window.
 */
export function centerIndent(blockWidth: number, columns: number): number {
  if (blockWidth >= columns) return 0;
  return Math.max(GUTTER.length, Math.floor((columns - blockWidth) / 2));
}

/** The widest line of a multi-line block, in terminal cells. */
export function blockWidth(block: string): number {
  return block.split("\n").reduce((max, line) => Math.max(max, width(line)), 0);
}

export function header(options: RenderOptions = {}): string[] {
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  const columns = options.columns ?? 80;

  const brand = `${s.hex(PALETTE.accent, g.unicode ? "◆" : "*")} ${s.bold("pew2")}`;
  const title = s.dim("pair a device");
  const inner = Math.max(20, Math.min(columns, 72) - GUTTER.length * 2);
  const spacer = " ".repeat(Math.max(1, inner - width(brand) - width(title)));

  return [
    "",
    `${GUTTER}${brand}${spacer}${title}`,
    `${GUTTER}${s.hex(PALETTE.faint, g.rule.repeat(inner))}`,
    "",
  ];
}

/** The two things the user physically does, numbered so neither is skipped. */
export function steps(options: RenderOptions = {}): string[] {
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  const bullet = (n: number) => s.hex(PALETTE.accent, g.unicode ? ["①", "②"][n - 1]! : `${n}.`);

  return [
    `${GUTTER}${bullet(1)} ${s.dim("Open")} pew2 ${s.dim("on your phone")}`,
    `${GUTTER}${bullet(2)} ${s.dim("Tap")} Pair ${s.dim("and scan the code above")}`,
  ];
}

/**
 * The status rows: reach, daemon, token.
 *
 * Each is a checked fact. `reach` is the one that decides whether this pairing
 * survives leaving the house, so it leads — and it says "same Wi-Fi only" in
 * words rather than relying on a colour the user may not be able to see.
 */
export function statusRows(view: PairView, options: RenderOptions = {}): string[] {
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  const columns = options.columns ?? 80;
  const now = options.now ?? Date.now();
  const room = Math.max(24, columns - GUTTER.length - LABEL - 4);
  // U+2026 is not in the Windows console's default codepage, so the elisions
  // have to degrade alongside the box drawing rather than independently of it.
  const ellipsis = g.unicode ? "…" : "...";

  const label = (text: string) => s.hex(PALETTE.faint, padEnd(text, LABEL));
  const mark = (state: "ok" | "warn" | "bad") =>
    state === "ok"
      ? s.hex(PALETTE.success, g.tick)
      : state === "warn"
        ? s.hex(PALETTE.warning, g.warn)
        : s.hex(PALETTE.danger, g.cross);

  const rows: string[] = [];

  // ── reach ──────────────────────────────────────────────────────────────
  if (view.reach === "anywhere") {
    const host = truncate(hostOf(view.relay?.url ?? ""), room - 12, ellipsis);
    rows.push(`${GUTTER}${label("reach")}${mark("ok")} ${s.bold("anywhere")} ${s.dim(`${g.dot} ${host}`)}`);
  } else if (view.reach === "local") {
    const where = view.addresses[0] ?? "this machine";
    rows.push(
      `${GUTTER}${label("reach")}${mark("warn")} ${s.bold("same Wi-Fi only")} ${s.dim(`${g.dot} ${where}`)}`,
    );
  } else {
    rows.push(`${GUTTER}${label("reach")}${mark("bad")} ${s.bold("no route to this machine")}`);
  }

  // ── relay ──────────────────────────────────────────────────────────────
  // Only shown when one is configured, and only ever reports what the health
  // check actually returned.
  if (view.relay) {
    const { healthy } = view.relay;
    rows.push(
      healthy === true
        ? `${GUTTER}${label("relay")}${mark("ok")} ${s.dim("responding")}`
        : healthy === false
          ? `${GUTTER}${label("relay")}${mark("bad")} ${s.bold("not responding")} ${s.dim(`${g.dot} pairing will not connect`)}`
          : `${GUTTER}${label("relay")}${s.dim(`${g.dot} not checked`)}`,
    );
  }

  // ── daemon ─────────────────────────────────────────────────────────────
  rows.push(
    view.daemonRunning
      ? `${GUTTER}${label("daemon")}${mark("ok")} ${s.dim(`running ${g.dot} port ${view.port}`)}`
      : `${GUTTER}${label("daemon")}${mark("bad")} ${s.bold("not running")} ${s.dim(`${g.dot} pew2 service install`)}`,
  );

  // ── token ──────────────────────────────────────────────────────────────
  // Elided on purpose. The full secret is one line below in the URL, where the
  // user has chosen to look; it should not also be in every screenshot of the
  // status block.
  const age = view.rotated ? "just rotated" : relativeAge(view.createdAt, now);
  rows.push(
    `${GUTTER}${label("token")}${s.dim(`${fingerprint(view.token, 6, 4, ellipsis)} ${g.dot} ${age}`)}`,
  );

  return rows;
}

/**
 * The pairing URL, printed on one unwrapped line.
 *
 * Deliberately not hard-wrapped to the terminal width: a soft wrap can be
 * selected and copied as a single string, whereas an inserted newline produces
 * a URL that silently fails to parse when pasted. The token is visible here
 * because pairing by hand is the fallback when a camera will not cooperate.
 */
export function urlBlock(view: PairView, options: RenderOptions = {}): string[] {
  const s = options.style ?? styler();
  return ["", `${GUTTER}${s.hex(PALETTE.faint, "or paste this link into the app")}`, `${GUTTER}${s.dim(view.url)}`];
}

/** The waiting line's text, before the spinner glyph is prepended. */
export function waitingLabel(view: PairView, options: RenderOptions = {}): string {
  const s = options.style ?? styler();
  return view.reach === "anywhere"
    ? `${s.dim("waiting for your phone")}`
    : `${s.dim("waiting for your phone")} ${s.hex(PALETTE.faint, "(same Wi-Fi)")}`;
}

/** The line that replaces the spinner once a device actually connects. */
export function pairedLine(
  deviceName: string,
  elapsedMs: number,
  options: RenderOptions = {},
): string {
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  const seconds = (elapsedMs / 1000).toFixed(1);
  return `${GUTTER}${s.hex(PALETTE.success, g.tick)} ${s.bold("paired")} ${s.dim(`${g.dot} ${deviceName} ${g.dot} ${seconds}s`)}`;
}

/** Shown when nobody scanned. Not an error: the link stays valid. */
export function timeoutLines(options: RenderOptions = {}): string[] {
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  return [
    `${GUTTER}${s.hex(PALETTE.faint, g.dot)} ${s.dim("stopped waiting — the code above stays valid")}`,
  ];
}

/** The keyboard hint, omitted when there is no keyboard to press. */
export function hintLine(interactive: boolean, options: RenderOptions = {}): string[] {
  if (!interactive) return [];
  const s = options.style ?? styler();
  return [
    "",
    `${GUTTER}${s.hex(PALETTE.faint, "c")} ${s.dim("copy link")}   ${s.hex(PALETTE.faint, "q")} ${s.dim("quit")}`,
  ];
}

/**
 * Everything above the live line, in order.
 *
 * Returned as one array rather than printed so a caller can measure it, test it
 * or write it somewhere other than stdout.
 */
export function renderPair(
  view: PairView,
  qr: string | undefined,
  options: RenderOptions = {},
): string[] {
  const columns = options.columns ?? 80;
  const lines: string[] = [...header(options)];

  if (qr) {
    lines.push(indent(qr, centerIndent(blockWidth(qr), columns)));
    lines.push("");
  }

  lines.push(...steps(options));
  lines.push("");
  lines.push(...statusRows(view, options));
  lines.push(...urlBlock(view, options));

  if (view.rotated) {
    const s = options.style ?? styler();
    const g = options.glyph ?? glyphs();
    lines.push(
      "",
      `${GUTTER}${s.hex(PALETTE.warning, g.warn)} ${s.dim("token rotated — devices paired before now must scan again")}`,
    );
  }

  return lines;
}

/** Host of a ws/wss/http origin, or the raw string when it will not parse. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin.replace(/^\w+:\/\//, "").replace(/\/$/, "");
  }
}
