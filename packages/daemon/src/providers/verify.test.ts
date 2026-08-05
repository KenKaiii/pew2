/**
 * Turning an agent's failure into something a person can act on.
 *
 * Agents report failures as JSON-RPC error objects, and the useful sentence is
 * almost never in the field you would expect. What `describe` returns does not
 * just get printed — `pew2 setup` pattern-matches it to decide whether an agent
 * merely needs signing in or is genuinely broken, so a vague string is not a
 * cosmetic problem. It puts a working agent in the wrong section.
 */
import { expect, test } from "bun:test";
import { describe as describeError } from "./verify.js";
import { needsSetup } from "../cli/setup-view.js";

test("the real explanation is read out of `data`, not `message`", () => {
  // JSON-RPC puts "Internal error" in `message` and the reason in `data`.
  expect(
    describeError({
      code: -32603,
      message: "Internal error",
      data: "Configuration value not found: GOOSE_PROVIDER",
    }),
  ).toBe("Configuration value not found: GOOSE_PROVIDER");
});

test("`data` nested one deeper is still found", () => {
  expect(
    describeError({ message: "Internal error", data: { message: "Authentication required" } }),
  ).toBe("Authentication required");
});

test("an object with nothing readable never renders as [object Object]", () => {
  // The old fallback was String(error), which on an object produces literally
  // "[object Object]" — the unexplained crash this function exists to prevent.
  const text = describeError({ code: -32000 });

  expect(text).not.toContain("[object Object]");
  expect(text).toContain("-32000");
});

test("an unreadable failure does not get filed as broken on the setup screen", () => {
  // Why the above matters. "[object Object]" matches none of needsSetup's
  // patterns, so an agent that only needed signing in was sorted under "Not
  // working" — the exact scare the setup screen was rebuilt to stop.
  expect(needsSetup(describeError({ data: { message: "Please authenticate first" } }))).toBe(true);
  expect(describeError({ code: 1 })).not.toBe("[object Object]");
});

test("a value that refuses to serialise still says something", () => {
  const circular: Record<string, unknown> = {};
  circular.self = circular;

  const text = describeError(circular);
  expect(text).toBe("the agent failed without saying why");
});

test("an Error with no message falls back to its name, not its shape", () => {
  expect(describeError(new TypeError(""))).toBe("TypeError");
  expect(describeError(new Error("spawn ENOENT"))).toBe("spawn ENOENT");
});

test("primitives are still described directly", () => {
  expect(describeError("plain failure")).toBe("plain failure");
  expect(describeError(undefined)).toBe("undefined");
});
