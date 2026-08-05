/**
 * The pairing screen is the first thing a new user sees, so its failure modes
 * are worth pinning down: a status line that overstates reachability, colour
 * that carries meaning no plain-text reader can recover, and a URL broken
 * across lines are all bugs that produce a support conversation rather than a
 * stack trace.
 */
import { expect, test } from "bun:test";
import {
  blockWidth,
  centerIndent,
  hostOf,
  indent,
  pairedLine,
  renderPair,
  statusRows,
  type PairView,
} from "./pair-view.js";
import { fingerprint, glyphs, relativeAge, stripAnsi, styler, to256, width } from "./ui.js";

const plain = { style: styler(0), glyph: glyphs(true), columns: 80 };

function view(overrides: Partial<PairView> = {}): PairView {
  return {
    url: "wss://relay.example.com/connect?pairing=" + "a".repeat(48) + "&role=app&deviceId=phone",
    token: "a".repeat(48),
    createdAt: new Date("2026-01-01T00:00:00Z").toISOString(),
    reach: "anywhere",
    relay: { url: "wss://relay.example.com", healthy: true },
    addresses: ["192.168.1.24"],
    port: 8787,
    daemonRunning: true,
    rotated: false,
    ...overrides,
  };
}

test("reachability is reported from the health check, not from configuration", () => {
  // The dangerous case: a relay is configured, so the old output said "works
  // from anywhere" — while the relay was down and nothing could connect.
  const down = statusRows(view({ reach: "unreachable", relay: { url: "wss://relay.example.com", healthy: false } }), plain)
    .map(stripAnsi)
    .join("\n");

  expect(down).toContain("no route to this machine");
  expect(down).toContain("not responding");
  expect(down).not.toContain("anywhere");

  const up = statusRows(view(), plain).map(stripAnsi).join("\n");
  expect(up).toContain("anywhere");
  expect(up).toContain("relay.example.com");
});

test("a LAN-only pairing says so in words, not only in colour", () => {
  const rows = statusRows(view({ reach: "local", relay: undefined }), plain).map(stripAnsi);
  const text = rows.join("\n");

  // Stripped of every escape, the limitation must survive.
  expect(text).toContain("same Wi-Fi only");
  expect(text).toContain("192.168.1.24");
  // No relay configured means no relay row to be confused by.
  expect(text).not.toContain("relay");
});

test("the token is elided in the status block", () => {
  const secret = "b".repeat(48);
  const rows = statusRows(view({ token: secret }), plain).map(stripAnsi).join("\n");

  expect(rows).not.toContain(secret);
  expect(rows).toContain(fingerprint(secret));
  // Enough to compare against another machine, not enough to retype.
  expect(fingerprint(secret).length).toBeLessThan(secret.length / 2);
});

test("the pairing URL is printed on one unbroken line", () => {
  // A hard wrap produces a URL that fails to parse when pasted, which is the
  // fallback path for anyone whose camera will not cooperate.
  const rendered = renderPair(view(), undefined, { ...plain, columns: 40 });
  const urlLine = rendered.map(stripAnsi).find((line) => line.includes("wss://"));

  expect(urlLine).toBeDefined();
  // The line hangs off the rail now, so the pipe and its padding come off
  // before comparing. What this guards is that nothing was inserted *into* the
  // URL, which is still exactly as true with a prefix as without one.
  const url = urlLine!.replace(/^[│|]\s*/, "");
  expect(url).toBe(view().url);
  expect(new URL(url).searchParams.get("pairing")).toBe("a".repeat(48));
});

test("a stopped daemon is called out with the command that fixes it", () => {
  const rows = statusRows(view({ daemonRunning: false }), plain).map(stripAnsi).join("\n");
  expect(rows).toContain("not running");
  expect(rows).toContain("pew2 service install");
});

test("rotation warns that existing devices are now unpaired", () => {
  const text = renderPair(view({ rotated: true }), undefined, plain).map(stripAnsi).join("\n");
  expect(text).toContain("must scan again");
  // Age is meaningless for a token minted a millisecond ago.
  expect(text).toContain("just rotated");
});

test("the QR is centred without touching its own escape sequences", () => {
  // The QR sets a background per cell; indenting inside the escapes would bleed
  // the terminal's own background into the quiet zone and can stop it scanning.
  const qr = "\x1b[107m▀▀▀\x1b[0m\n\x1b[107m▀▀▀\x1b[0m";
  const shifted = indent(qr, 4);

  expect(shifted.split("\n").every((line) => line.startsWith("    \x1b["))).toBe(true);
  expect(blockWidth(qr)).toBe(3);
  expect(width(shifted.split("\n")[0]!)).toBe(7);
});

test("centring never pushes a wide block off the left edge", () => {
  expect(centerIndent(50, 80)).toBe(15);
  // A QR wider than the window is left-aligned rather than negatively indented.
  expect(centerIndent(90, 80)).toBe(0);
  // The floor is the rail gutter — pipe plus two spaces — not bare indentation.
  expect(centerIndent(78, 80)).toBe(3);
});

test("the paired line names the device and how long it took", () => {
  const line = stripAnsi(pairedLine("Kens-iPhone", 4231, plain));
  expect(line).toContain("paired");
  expect(line).toContain("Kens-iPhone");
  expect(line).toContain("4.2s");
});

test("ASCII output degrades without losing any information", () => {
  const ascii = { style: styler(0), glyph: glyphs(false), columns: 80 };
  const text = renderPair(view({ reach: "local", relay: undefined }), undefined, ascii).join("\n");

  // Nothing outside ASCII at all: box drawing, braille, circled digits and the
  // ellipsis are all rendered as replacement boxes by the Windows console, and
  // degrading only some of them is the same bug with a smaller blast radius.
  // The URL is excluded because it is data, not decoration.
  const decoration = text.split("\n").filter((line) => !line.includes("://")).join("\n");
  expect(/[^\x00-\x7f]/.test(decoration)).toBe(false);

  expect(text).toContain("same Wi-Fi only");
  expect(text).toContain("1.");
  // The token is still elided, just with an ASCII ellipsis.
  expect(decoration).toContain("aaaaaa...aaaa");
});

test("hostOf survives a malformed relay origin", () => {
  expect(hostOf("wss://relay.example.com/")).toBe("relay.example.com");
  expect(hostOf("wss://relay.example.com:8443")).toBe("relay.example.com:8443");
  expect(hostOf("not a url")).toBe("not a url");
});

test("colour degrades to 256 and then to nothing", () => {
  expect(styler(0).hex("#d97757", "x")).toBe("x");
  expect(styler(2).hex("#d97757", "x")).toContain("38;2;217;119;87");
  expect(styler(1).hex("#d97757", "x")).toContain(`38;5;${to256("#d97757")}`);
  // Near-greys use the grey ramp; the colour cube gives them a visible cast.
  expect(to256("#9a9aa0")).toBeGreaterThanOrEqual(232);
});

test("token age reads as a human would say it", () => {
  const now = Date.parse("2026-01-10T00:00:00Z");
  expect(relativeAge("2026-01-09T23:59:50Z", now)).toBe("just now");
  expect(relativeAge("2026-01-09T23:00:00Z", now)).toBe("1 hour ago");
  expect(relativeAge("2026-01-05T00:00:00Z", now)).toBe("5 days ago");
  expect(relativeAge("nonsense", now)).toBe("unknown age");
});

test("a QR that barely fits is never pushed into a wrap by the rail", () => {
  // A wrapped QR cannot be scanned, and the rail is three columns wide, so a
  // code that fit exactly before the rail existed must not now overflow. When
  // there is no room for both, the code wins and the rail breaks for it.
  const row = "\x1b[107m" + "▀".repeat(49) + "\x1b[0m";
  const qr = [row, row].join("\n");

  for (const columns of [49, 51, 52, 60]) {
    const lines = renderPair(view(), qr, { ...plain, columns });
    const qrLines = lines.filter((l) => l.includes("▀"));
    expect(qrLines.length).toBe(2);
    for (const line of qrLines) {
      expect(width(stripAnsi(line)), `${columns} cols`).toBeLessThanOrEqual(columns);
    }
  }
});

test("a QR too wide for the window is left alone rather than indented", () => {
  const row = "\x1b[107m" + "▀".repeat(70) + "\x1b[0m";
  const lines = renderPair(view(), row, { ...plain, columns: 40 });
  const qrLine = lines.find((l) => l.includes("▀"))!;

  // No rail prefix and no padding: every cell of the window belongs to the code.
  expect(qrLine.startsWith("\x1b[107m")).toBe(true);
});
