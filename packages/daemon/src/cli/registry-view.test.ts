import { test, expect } from "bun:test";
import { registryView } from "./registry-view.js";
import { stripAnsi, styler, glyphs } from "./ui.js";
import type { SyncResult } from "./registry-sync.js";

const plain = { style: styler(0), glyph: glyphs(true), columns: 80 };

function result(over: Partial<SyncResult> = {}): SyncResult {
  return {
    registryVersion: "1.0.0",
    written: [],
    unchanged: [],
    conflicts: [],
    skipped: [],
    targetDir: "/home/u/.pew2/providers",
    ...over,
  };
}

test("thirty agents are a sentence, not thirty lines", () => {
  const ids = Array.from({ length: 30 }, (_, i) => `agent-${i}`);
  const lines = registryView(result({ written: ids }), plain).map(stripAnsi);

  expect(lines.join("\n")).toContain("30 agents");
  // The point of the change: the body must not grow a row per agent.
  expect(lines.length).toBeLessThan(20);
  for (const id of ids) expect(lines.join(" ")).toContain(id);
});

test("a dry run never claims it did anything", () => {
  const text = registryView(result({ written: ["a", "b"] }), { ...plain, dryRun: true })
    .map(stripAnsi)
    .join("\n");

  expect(text).toContain("Would add");
  expect(text).toContain("would be added");
  expect(text).toContain("--dry-run");
  // The failure that matters is a dry run reporting completed work.
  expect(text).not.toContain("2 agents added.");
  expect(text).not.toContain("Added");
});

test("a conflict gets its own row, because it is the only thing to decide", () => {
  const text = registryView(result({ written: ["a"], conflicts: ["devin", "kimi"] }), plain)
    .map(stripAnsi)
    .join("\n");

  expect(text).toContain("Left alone");
  expect(text).toContain("devin");
  expect(text).toContain("kimi");
  expect(text).toContain("--force to replace them");
});

test("one conflict is referred to in the singular", () => {
  const text = registryView(result({ conflicts: ["devin"] }), plain).map(stripAnsi).join("\n");
  expect(text).toContain("--force to replace it.");
});

test("nothing to do is said plainly rather than as an empty screen", () => {
  const text = registryView(
    result({ unchanged: ["a", "b"], skipped: [{ id: "c", kind: "bundled", reason: "ships with pew2" }] }),
    plain,
  )
    .map(stripAnsi)
    .join("\n");

  expect(text).toContain("Nothing to do");
  expect(text).toContain("2 already up to date");
  expect(text).toContain("1 already ship with pew2");
});

test("an agent that cannot run here is context, not a failure", () => {
  const text = registryView(
    result({ written: ["a"], skipped: [{ id: "x", kind: "unsupported", reason: "no linux build" }] }),
    plain,
  )
    .map(stripAnsi)
    .join("\n");

  expect(text).toContain("1 not available on this platform");
  expect(text).not.toContain("✗");
  expect(text).not.toMatch(/error|fail/i);
});

test("every line stays on the rail", () => {
  const lines = registryView(result({ written: ["a"], conflicts: ["b"] }), plain)
    .map(stripAnsi)
    .filter((l) => l !== "");

  expect(lines.every((l) => /^[│◇◆└]/.test(l))).toBe(true);
});
