/**
 * Where a link in a message should open.
 *
 * Pure and React-free so the scheme rules are directly testable; the binding to
 * the in-app browser lives in `MarkdownText.tsx`, which is the only place that
 * may import `expo-*`.
 *
 * Three answers, because a link in a transcript is not one kind of thing. Most
 * are `https` and belong in the in-app browser: an agent run is happening on
 * the other end of this socket, and being thrown into Safari to read a doc page
 * puts the app in the background — where it can lose the socket, and where a
 * permission request goes unanswered until the user thinks to come back.
 * `mailto:`, `tel:` and an agent's own custom scheme have no web page to show
 * and must go to the OS. And a handful of schemes are not navigation at all.
 *
 * That last group is why this is a whitelist by shape rather than a `canOpenURL`
 * check. Message text is written by an agent — often quoting a file, a web page
 * or a tool result — so `javascript:` and `data:` URLs can appear in the
 * transcript without anybody having chosen to put them there, and neither
 * belongs in a browser tab opened by a tap.
 */

export type LinkTarget =
  /** An ordinary web page: opens in the in-app browser. */
  | "browser"
  /** A scheme only the OS can service: mail, phone, another app. */
  | "external"
  /** Nothing safe or meaningful to open. */
  | "unsupported";

/**
 * Schemes that execute or inline content rather than naming a destination.
 * `blob:` and `filesystem:` are included for the same reason: they address this
 * process's own memory, which a browser tab cannot resolve anyway.
 */
const NEVER_OPEN = new Set(["javascript", "data", "vbscript", "blob", "filesystem", "about"]);

/** RFC 3986 scheme, which is the only part of a URL this needs to understand. */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

export function linkTarget(url: string): LinkTarget {
  const trimmed = url.trim();
  const scheme = SCHEME.exec(trimmed)?.[1]?.toLowerCase();
  // Relative paths, bare fragments and `example.com` with no scheme: the
  // renderer will hand those over, and there is no base URL to resolve them
  // against — a transcript is not a web page.
  if (!scheme) return "unsupported";
  if (NEVER_OPEN.has(scheme)) return "unsupported";
  if (scheme === "http" || scheme === "https") return "browser";
  return "external";
}
