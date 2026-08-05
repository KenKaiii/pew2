/**
 * The five commands must look like one program.
 *
 * `setup`, `pair`, `doctor`, `providers list` and `registry sync` used to be
 * drawn three different ways, and nothing stopped a sixth screen from inventing
 * a fourth. These tests are the thing that stops it: they assert the shared
 * chrome across every screen at once, so a new command that skips the rail fails
 * here rather than shipping.
 */
import { test, expect } from "bun:test";
import { stripAnsi, styler, glyphs } from "./ui.js";
import { agentSections, providerList, type AgentState } from "./setup-view.js";
import { doctorView } from "./doctor-view.js";
import { registryView } from "./registry-view.js";
import { closingLines, renderPair, type PairView } from "./pair-view.js";
import type { DoctorReport } from "./doctor.js";
import type { SyncResult } from "./registry-sync.js";

const plain = { style: styler(0), glyph: glyphs(true), columns: 80 };

const agents: AgentState[] = [
  { id: "claude-code", name: "Claude Code", missingEnv: [], notInstalled: false },
  { id: "codex", name: "Codex", missingEnv: [], notInstalled: true, install: "npm i -g codex" },
];

const doctorReport: DoctorReport = {
  ok: true,
  providerDirs: ["/p"],
  providers: [{ id: "claude-code", available: true, source: "/p/c.json" }],
  daemon: { url: "http://127.0.0.1:8787", reachable: true, autostart: true },
  pairing: { addresses: ["10.0.0.2"], relay: "wss://r.dev", remote: true },
  problems: [],
};

const syncResult: SyncResult = {
  registryVersion: "1.0.0",
  written: ["devin"],
  unchanged: [],
  conflicts: [],
  skipped: [],
  targetDir: "/p",
};

const pairView: PairView = {
  url: "wss://r.dev/connect?pairing=" + "a".repeat(48) + "#k=key",
  token: "b".repeat(48),
  createdAt: new Date().toISOString(),
  reach: "anywhere",
  relay: { url: "wss://r.dev", healthy: true },
  addresses: ["10.0.0.2"],
  port: 8787,
  daemonRunning: true,
  rotated: false,
};

/** Every screen, rendered the way its command renders it. */
const screens: Record<string, string[]> = {
  setup: agentSections(agents, plain),
  "providers list": providerList(agents, plain),
  doctor: doctorView(doctorReport, plain),
  "registry sync": registryView(syncResult, plain),
  pair: renderPair(pairView, undefined, plain),
};

test("every screen draws the same rail", () => {
  for (const [name, lines] of Object.entries(screens)) {
    const body = lines.map(stripAnsi).filter((l) => l !== "");
    const stray = body.filter((l) => !/^[│◇◆└]/.test(l));
    expect(stray, `${name} has lines off the rail: ${stray.join(" | ")}`).toEqual([]);
  }
});

test("the rail is never broken by a blank line mid-screen", () => {
  // Filtering empties out of the test above hid a real gap: `pair --rotate`
  // separated its warning with "" instead of a `│`, leaving a hole in the rail.
  // Only the opening and closing blank lines are legitimate.
  const rotated = renderPair({ ...pairView, rotated: true }, undefined, plain).map(stripAnsi);
  // Trim the leading and trailing blanks the intro and outro own, then assert
  // on what is left — rather than slicing fixed indices, which would silently
  // stop covering the last line if the screen grew one.
  let start = 0;
  let end = rotated.length;
  while (start < end && rotated[start] === "") start++;
  while (end > start && rotated[end - 1] === "") end--;
  expect(rotated.slice(start, end).filter((l) => l === "")).toEqual([]);
});

test("every full screen opens with the mark and names itself pew2", () => {
  // agentSections and providerList are fragments of the setup screen, so only
  // the screens that own their whole output are checked for an opening.
  for (const name of ["doctor", "registry sync", "pair"]) {
    const first = screens[name]!.map(stripAnsi).filter((l) => l !== "")[0]!;
    expect(first, name).toMatch(/^◆\s+pew2/);
  }
});

test("no screen shouts about something the user has not installed", () => {
  // The rule the whole redesign turns on: absence is not failure. A cross or
  // the word "error" against an agent nobody asked for is what made a normal
  // machine look broken.
  for (const [name, lines] of Object.entries(screens)) {
    const text = stripAnsi(lines.join("\n"));
    expect(text, name).not.toMatch(/\berror\b/i);
    expect(text, name).not.toMatch(/\bfailed\b/i);
    expect(text, name).not.toMatch(/cannot start/i);
  }
});

test("no screen tells anyone to delete a manifest", () => {
  // This was doctor's advice for every agent you had not installed, and it
  // would have removed the very file that makes the agent installable later.
  for (const [name, lines] of Object.entries(screens)) {
    expect(stripAnsi(lines.join("\n")), name).not.toMatch(/delete/i);
  }
});

test("section headings are sentence case, not shouted or lowercased", () => {
  for (const [name, lines] of Object.entries(screens)) {
    const headings = lines
      .map(stripAnsi)
      .filter((l) => l.startsWith("◇"))
      .map((l) => l.slice(1).trim());

    for (const heading of headings) {
      expect(heading, `${name}: ${heading}`).toMatch(/^[A-Z]/);
      expect(heading, `${name}: ${heading}`).not.toBe(heading.toUpperCase());
    }
  }
});

test("all screens degrade to ASCII together", () => {
  // A terminal that cannot draw the pipe cannot draw any of it, so no screen may
  // hardcode a glyph that survives the ASCII fallback.
  //
  // The screens are fed their *worst* case here, not their empty one: an earlier
  // version of this test passed while `doctor` printed a U+2026 on an ASCII
  // terminal, purely because the fixture had no problems in it.
  const ascii = { style: styler(0), glyph: glyphs(false), columns: 80 };
  const rendered = [
    agentSections(agents, ascii),
    providerList(agents, ascii),
    doctorView(
      {
        ...doctorReport,
        ok: false,
        problems: [
          {
            id: "provider-missing-env",
            severity: "warning",
            provider: "gemini-cli",
            detail: "Gemini CLI needs GEMINI_API_KEY.",
            fix: "Set GEMINI_API_KEY in the environment where the daemon runs",
          },
          {
            id: "daemon-unreachable",
            severity: "error",
            detail: "Nothing serving on http://127.0.0.1:8787.",
            fix: "pew2 setup",
          },
        ],
      },
      ascii,
    ),
    registryView(
      { ...syncResult, conflicts: ["devin"], skipped: [{ id: "x", kind: "unsupported", reason: "no build" }] },
      ascii,
    ),
    renderPair(pairView, undefined, ascii),
    // Both closings: the daemon-down one carries a cross glyph.
    closingLines(true, ascii),
    closingLines(false, ascii),
  ];

  for (const lines of rendered) {
    const text = stripAnsi(lines.join("\n"));
    expect(/[^\x00-\x7F]/.test(text)).toBe(false);
  }
});
