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

test("Ctrl-C stops the program rather than skipping the question", async () => {
  // It used to resolve as a plain "cancel", so setup carried on and printed its
  // closing summary — which reads as the interrupt having been ignored.
  const written: string[] = [];
  let exitCode: number | undefined;

  // A fake TTY that delivers Ctrl-C as soon as anything listens.
  const stream = {
    isTTY: true,
    setRawMode: () => {},
    resume: () => {},
    pause: () => {},
    off: () => {},
    once: () => {},
    on: (event: string, listener: (chunk: Buffer) => void) => {
      if (event === "data") queueMicrotask(() => listener(Buffer.from("\u0003", "utf8")));
    },
  } as unknown as NodeJS.ReadStream;

  await pickAgents(items, {
    stream,
    write: (t) => written.push(t),
    exit: ((code: number) => {
      exitCode = code;
    }) as unknown as (code: number) => never,
  });

  // 130 is the conventional code for "killed by SIGINT".
  expect(exitCode).toBe(130);
  // And the cursor is back, or the user's shell is left broken after we exit.
  expect(written.join("")).toContain("\u001b[?25h");
});
