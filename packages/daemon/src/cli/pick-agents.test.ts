import { test, expect } from "bun:test";
import { pickAgents } from "./pick-agents.js";
import type { PickerItem } from "./picker.js";

const items: PickerItem[] = [
  { id: "claude-code", name: "Claude Code", selectable: true },
  { id: "opencode", name: "OpenCode", selectable: true },
  { id: "codex", name: "Codex", selectable: false },
];

test("without a terminal it takes the defaults instead of waiting forever", async () => {
  // The path a script, a pipe or CI takes. Blocking on input that can never
  // arrive would hang the install rather than fail it.
  const written: string[] = [];
  const chosen = await pickAgents(items, {
    stream: { isTTY: false } as NodeJS.ReadStream,
    write: (t) => written.push(t),
  });

  expect(chosen).toEqual(new Set(["claude-code", "opencode"]));
  // And it still says what happened, so a log shows the outcome.
  expect(written.join("")).toContain("2 agents");
});

test("a previous choice survives a non-interactive run", async () => {
  // `pew2 setup` piped into a log must not quietly re-enable what someone
  // turned off by hand.
  const chosen = await pickAgents(items, {
    disabled: new Set(["opencode"]),
    stream: { isTTY: false } as NodeJS.ReadStream,
    write: () => {},
  });

  expect(chosen).toEqual(new Set(["claude-code"]));
});

test("the cursor is always restored", async () => {
  // It is hidden while the list is live. Leaving it hidden breaks the user's
  // shell after the command exits, which is worse than any missing feature.
  const written: string[] = [];
  await pickAgents(items, {
    stream: { isTTY: false } as NodeJS.ReadStream,
    write: (t) => written.push(t),
  });

  const out = written.join("");
  expect(out).toContain("\u001b[?25l");
  expect(out).toContain("\u001b[?25h");
  expect(out.lastIndexOf("\u001b[?25h")).toBeGreaterThan(out.lastIndexOf("\u001b[?25l"));
});
