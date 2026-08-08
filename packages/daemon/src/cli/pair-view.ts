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
import { rail } from "./rail.js";
import { isRealClaim } from "../device-claim.js";

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
  /**
   * The device already using this pairing, if one has claimed it.
   *
   * A link admits one device, so a code printed for an already-claimed pairing
   * cannot onboard a second phone. Saying so here is the difference between a
   * one-line fix and scanning a QR that answers with a refusal.
   *
   * A placeholder left by a pre-gate app is not a real claim and is not
   * announced; `isRealClaim` decides, so the screen and the gate cannot drift
   * into disagreeing about who owns a pairing.
   */
  claimedBy?: string;
}

export interface RenderOptions {
  style?: Style;
  glyph?: Glyphs;
  columns?: number;
  now?: number;
}

/** Visible width of the rail prefix: the pipe plus its two-space hang. */
const GUTTER_WIDTH = 3;

/**
 * The rail prefix every line hangs off.
 *
 * This screen used to indent with two plain spaces under its own rule, which
 * made `pew2 pair` the one command that did not look like the rest of pew2.
 * The pipe carries colour, so unlike a bare string it has to be built per call
 * from the caller's style.
 */
function gut(options: RenderOptions = {}): string {
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  return `${s.hex(PALETTE.faint, g.unicode ? "\u2502" : "|")}  `;
}

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
 *
 * Returns 0 — not the gutter — when the block is wider than the terminal, so a
 * QR in a narrow window gets every cell of the width available to it. Callers
 * must drop the rail prefix in that case too, or they hand back the columns
 * this just protected.
 */
export function centerIndent(blockWidth: number, columns: number): number {
  if (blockWidth >= columns) return 0;
  return Math.max(GUTTER_WIDTH, Math.floor((columns - blockWidth) / 2));
}

/** The widest line of a multi-line block, in terminal cells. */
export function blockWidth(block: string): number {
  return block.split("\n").reduce((max, line) => Math.max(max, width(line)), 0);
}

/**
 * The opening mark.
 *
 * Was a brand line and a full-width rule, which is why this screen read as a
 * different program to every other command. It is the shared rail intro now,
 * and the rule is gone: the pipe already does the job of tying the screen
 * together, and a rule on top of it is two borders doing one job.
 */
export function header(options: RenderOptions = {}): string[] {
  return rail(options).intro("pew2 pair", "connect a phone");
}

/** The two things the user physically does, numbered so neither is skipped. */
export function steps(options: RenderOptions = {}): string[] {
  const g_ = gut(options);
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  const bullet = (n: number) => s.hex(PALETTE.accent, g.unicode ? ["①", "②"][n - 1]! : `${n}.`);

  return [
    ...rail(options).step("On your phone"),
    `${g_}${bullet(1)} ${s.dim("Open")} pew2 ${s.dim("on your phone")}`,
    `${g_}${bullet(2)} ${s.dim("Tap")} Pair ${s.dim("and scan the code above")}`,
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
  const g_ = gut(options);
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  const columns = options.columns ?? 80;
  const now = options.now ?? Date.now();
  const room = Math.max(24, columns - GUTTER_WIDTH - LABEL - 4);
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

  rows.push(...rail(options).step("This machine"));

  // ── reach ──────────────────────────────────────────────────────────────
  if (view.reach === "anywhere") {
    const host = truncate(hostOf(view.relay?.url ?? ""), room - 12, ellipsis);
    rows.push(`${g_}${label("reach")}${mark("ok")} ${s.bold("anywhere")} ${s.dim(`${g.dot} ${host}`)}`);
  } else if (view.reach === "local") {
    const where = view.addresses[0] ?? "this machine";
    rows.push(
      `${g_}${label("reach")}${mark("warn")} ${s.bold("same Wi-Fi only")} ${s.dim(`${g.dot} ${where}`)}`,
    );
  } else {
    rows.push(`${g_}${label("reach")}${mark("bad")} ${s.bold("no route to this machine")}`);
  }

  // ── relay ──────────────────────────────────────────────────────────────
  // Only shown when one is configured, and only ever reports what the health
  // check actually returned.
  if (view.relay) {
    const { healthy } = view.relay;
    rows.push(
      healthy === true
        ? `${g_}${label("relay")}${mark("ok")} ${s.dim("responding")}`
        : healthy === false
          ? `${g_}${label("relay")}${mark("bad")} ${s.bold("not responding")} ${s.dim(`${g.dot} pairing will not connect`)}`
          : `${g_}${label("relay")}${s.dim(`${g.dot} not checked`)}`,
    );
  }

  // ── daemon ─────────────────────────────────────────────────────────────
  rows.push(
    view.daemonRunning
      ? `${g_}${label("daemon")}${mark("ok")} ${s.dim(`running ${g.dot} port ${view.port}`)}`
      : `${g_}${label("daemon")}${mark("bad")} ${s.bold("not running")} ${s.dim(`${g.dot} pew2 service install`)}`,
  );

  // ── token ──────────────────────────────────────────────────────────────
  // Elided on purpose. The full secret is one line below in the URL, where the
  // user has chosen to look; it should not also be in every screenshot of the
  // status block.
  const age = view.rotated ? "just rotated" : relativeAge(view.createdAt, now);
  rows.push(
    `${g_}${label("token")}${s.dim(`${fingerprint(view.token, 6, 4, ellipsis)} ${g.dot} ${age}`)}`,
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
  const g_ = gut(options);
  const s = options.style ?? styler();
  return [
    ...rail(options).step("Or paste this link", "if the camera will not read it"),
    `${g_}${s.dim(view.url)}`,
  ];
}

/**
 * The closing line when the screen is not going to wait for a device.
 *
 * Lives here rather than inline in the command because that is how it went
 * wrong: built by hand inside `cmdPair`, it was the one line on this screen
 * printed with a literal two-space indent instead of the rail, and no test
 * could see it. A daemon that is not running is the most important thing this
 * screen ever says, so it is a rendered value like everything else.
 */
export function closingLines(daemonRunning: boolean, options: RenderOptions = {}): string[] {
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  return rail(options).outro(
    daemonRunning
      ? s.dim("Scan the code above when you are ready.")
      : `${s.hex(PALETTE.danger, g.cross)} ${s.dim("Start the daemon before scanning:")} ${s.bold("pew2 service install")}`,
  );
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
  const g_ = gut(options);
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  const seconds = (elapsedMs / 1000).toFixed(1);
  return `${g_}${s.hex(PALETTE.success, g.tick)} ${s.bold("paired")} ${s.dim(`${g.dot} ${deviceName} ${g.dot} ${seconds}s`)}`;
}

/** Shown when nobody scanned. Not an error: the link stays valid. */
export function timeoutLines(options: RenderOptions = {}): string[] {
  const s = options.style ?? styler();
  const g = options.glyph ?? glyphs();
  return rail(options).outro(
    `${s.hex(PALETTE.faint, g.dot)} ${s.dim("Stopped waiting. The code above stays valid.")}`,
  );
}

/** The keyboard hint, omitted when there is no keyboard to press. */
export function hintLine(interactive: boolean, options: RenderOptions = {}): string[] {
  if (!interactive) return [];
  const g_ = gut(options);
  const s = options.style ?? styler();
  return [
    rail(options).bar(),
    `${g_}${s.hex(PALETTE.faint, "c")} ${s.dim("copy link")}   ${s.hex(PALETTE.faint, "q")} ${s.dim("quit")}`,
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
  const g_ = gut(options);
  const columns = options.columns ?? 80;
  const lines: string[] = [...header(options)];

  if (qr) {
    lines.push(rail(options).bar());
    // Centred in what is left after the rail, then hung off it like everything
    // else. The pipe is written before the QR's own escapes and the padding
    // after it is unstyled, so the quiet zone stays the terminal's background
    // — prefixing with a styled pad is what breaks scanning.
    //
    // Except when the code will not fit. A wrapped QR cannot be scanned at all,
    // and three columns of rail is enough to cause that on its own in a split
    // pane, so consistency loses to a code that works: the rail breaks for the
    // width of the QR rather than the QR breaking for the width of the rail.
    const block = blockWidth(qr);
    const fits = block + GUTTER_WIDTH <= columns;
    const pad = fits ? Math.max(0, centerIndent(block, columns) - GUTTER_WIDTH) : 0;
    for (const row of indent(qr, pad).split("\n")) lines.push(fits ? `${g_}${row}` : row);
  }

  lines.push(...steps(options));
  lines.push(...statusRows(view, options));
  lines.push(...urlBlock(view, options));

  if (view.rotated) {
    const s = options.style ?? styler();
    const g = options.glyph ?? glyphs();
    lines.push(
      rail(options).bar(),
      `${g_}${s.hex(PALETTE.warning, g.warn)} ${s.dim("token rotated — devices paired before now must scan again")}`,
    );
  } else if (isRealClaim(view.claimedBy)) {
    // Only when it was not just rotated: a rotation clears the claim, so both
    // notices at once would contradict each other.
    //
    // And only for a real claim. A pre-gate app stored the literal `phone`,
    // which the daemon treats as unclaimed and the next scan will take — so
    // warning about it would tell the user their code is spoken for at the exact
    // moment it is not.
    const s = options.style ?? styler();
    const g = options.glyph ?? glyphs();
    lines.push(
      rail(options).bar(),
      `${g_}${s.hex(PALETTE.warning, g.warn)} ${s.dim("already paired to a device — this code admits no other")}`,
      `${g_}  ${s.dim("to move to a different phone: pew2 pair --rotate")}`,
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
