import { test, expect } from "bun:test";
import { doctorView, checks, summary } from "./doctor-view.js";
import { stripAnsi, styler, glyphs } from "./ui.js";
import type { DoctorReport, Problem } from "./doctor.js";

const plain = { style: styler(0), glyph: glyphs(true), columns: 80 };

function report(over: Partial<DoctorReport> = {}): DoctorReport {
  return {
    ok: true,
    providerDirs: ["/p"],
    providers: [
      { id: "claude-code", available: true, source: "/p/claude-code.json" },
      { id: "codex", available: false, source: "/p/codex.json", reason: "not on PATH" },
    ],
    daemon: { url: "http://127.0.0.1:8787", reachable: true, autostart: true },
    pairing: { addresses: ["192.168.1.5"], relay: "wss://r.dev", remote: true },
    problems: [],
    ...over,
  };
}

const problem = (over: Partial<Problem> = {}): Problem => ({
  id: "local-only",
  severity: "warning",
  detail: "No relay. Works on the same network only.",
  fix: "pew2 relay wss://your-relay.workers.dev",
  ...over,
});

test("a healthy machine says so in one line and does not list the agents", () => {
  const text = doctorView(report(), plain).map(stripAnsi).join("\n");

  expect(text).toContain("Everything checks out");
  // The old screen printed a row per agent. Thirteen rows to say "fine" is the
  // thing being removed, so the ids must not be here.
  expect(text).not.toContain("claude-code");
  expect(text).toContain("1 agent ready");
});

test("an agent you have not installed is never mentioned as a finding", () => {
  // The whole complaint: a normal laptop showing eight warnings for agents the
  // user never asked for. Absence is reported by `providers list`, not here.
  const text = doctorView(report(), plain).map(stripAnsi).join("\n");

  expect(text).not.toContain("codex");
  expect(text).not.toContain("not on PATH");
  expect(text).not.toMatch(/delete/i);
});

test("a blocking problem leads with what to run", () => {
  const text = doctorView(
    report({
      ok: false,
      problems: [
        problem({ id: "daemon-unreachable", severity: "error", detail: "Nothing serving.", fix: "pew2 setup" }),
      ],
    }),
    plain,
  )
    .map(stripAnsi)
    .join("\n");

  expect(text).toContain("Stopping you");
  expect(text).toContain("Nothing serving.");
  expect(text).toContain("pew2 setup");
  expect(text).toContain("1 thing to fix");
});

test("warnings never contradict the closing line", () => {
  // The old screen ended "All good." underneath five warnings. Either it is
  // good or it is not, and both cannot be on screen at once.
  const text = doctorView(report({ problems: [problem()] }), plain).map(stripAnsi).join("\n");

  expect(text).toContain("Could be better");
  expect(text).toContain("Working.");
  expect(text).not.toContain("Everything checks out");
  expect(text).not.toContain("All good");
});

test("a warning alone is never described as something to fix", () => {
  const line = stripAnsi(summary(report({ problems: [problem()] }), plain));
  expect(line).not.toMatch(/to fix/);
});

test("reach is stated in words, not left to a colour", () => {
  const local = checks(report({ pairing: { addresses: [], relay: undefined, remote: false } }));
  expect(local.find((c) => c.label === "Reach")?.note).toBe("same Wi-Fi only");
  expect(checks(report()).find((c) => c.label === "Reach")?.note).toBe("anywhere, via relay");
});

test("counts read as English", () => {
  // A plural helper applied to a phrase produced "8 ready to runs".
  const one = checks(report({ providers: [{ id: "a", available: true, source: "/p/a.json" }] }));
  expect(one.find((c) => c.label === "Agents")?.note).toBe("1 agent ready");

  const two = checks(
    report({
      providers: [
        { id: "a", available: true, source: "/p/a.json" },
        { id: "b", available: true, source: "/p/b.json" },
      ],
    }),
  );
  expect(two.find((c) => c.label === "Agents")?.note).toBe("2 agents ready");
});

test("every line stays on the rail", () => {
  const lines = doctorView(
    report({ ok: false, problems: [problem({ severity: "error" }), problem()] }),
    plain,
  )
    .map(stripAnsi)
    .filter((l) => l !== "");

  expect(lines.every((l) => /^[│◇◆└]/.test(l))).toBe(true);
});
