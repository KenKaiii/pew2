import { expect, test } from "bun:test";
import { defaultProviderId } from "./lastProvider";

const providers = [
  { id: "claude-code", available: true },
  { id: "codex", available: true },
  { id: "gemini", available: false },
];

test("nothing remembered falls back to the first available agent", () => {
  expect(defaultProviderId(providers, undefined)).toBe("claude-code");
});

test("the remembered agent wins over manifest order", () => {
  expect(defaultProviderId(providers, "codex")).toBe("codex");
});

test("an unavailable remembered agent falls back", () => {
  expect(defaultProviderId(providers, "gemini")).toBe("claude-code");
});

test("an agent that no longer exists falls back", () => {
  expect(defaultProviderId(providers, "gone")).toBe("claude-code");
});

test("no available agent at all selects nothing", () => {
  expect(defaultProviderId([{ id: "gemini", available: false }], "gemini")).toBeUndefined();
});

test("providers not loaded yet selects nothing rather than the remembered id", () => {
  expect(defaultProviderId([], "codex")).toBeUndefined();
});
