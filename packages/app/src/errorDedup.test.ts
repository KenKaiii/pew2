import { expect, test } from "bun:test";
import { findDuplicateError } from "./errorDedup";

const turn = (role: "user" | "agent" | "thought" | "system", text: string) => ({
  role,
  text,
});

test("matches the streamed copy of an error the agent then rejected the turn with", () => {
  const turns = [
    turn("user", "Hi there"),
    turn("agent", "You've hit your session limit · resets 7:50pm (Asia/Kuala_Lumpur)"),
  ];

  expect(
    findDuplicateError(
      turns,
      "You've hit your session limit · resets 7:50pm (Asia/Kuala_Lumpur)",
    ),
  ).toBe(1);
});

test("ignores prefix, case, whitespace and trailing punctuation", () => {
  const turns = [turn("user", "Run it"), turn("agent", "  Network   unavailable.\n")];

  expect(findDuplicateError(turns, "Error: network unavailable")).toBe(1);
});

test("matches when the agent wrapped the same reason in prose", () => {
  const turns = [
    turn("user", "Run it"),
    turn("agent", "Sorry — you've hit your session limit, try later"),
  ];

  expect(findDuplicateError(turns, "You've hit your session limit")).toBe(1);
});

test("a short message is never matched by containment", () => {
  const turns = [turn("user", "Run it"), turn("agent", "The build was cancelled by the user")];

  // "Cancelled" inside a longer sentence is a coincidence, not the same event.
  expect(findDuplicateError(turns, "Cancelled")).toBe(-1);
});

test("does not match a different error", () => {
  const turns = [turn("user", "Run it"), turn("agent", "Network unavailable")];

  expect(findDuplicateError(turns, "Permission denied")).toBe(-1);
});

test("only looks at the current turn", () => {
  const turns = [
    turn("user", "First try"),
    turn("agent", "You've hit your session limit"),
    turn("user", "Try again"),
  ];

  // The same failure on a second prompt is a second event worth showing.
  expect(findDuplicateError(turns, "You've hit your session limit")).toBe(-1);
});

test("thought text does not consume a real error", () => {
  const turns = [turn("user", "Run it"), turn("thought", "This will hit the session limit")];

  expect(findDuplicateError(turns, "This will hit the session limit")).toBe(-1);
});

test("an already-red error is matched rather than repeated", () => {
  const turns = [turn("user", "Run it"), turn("system", "The agent hit an internal error.")];

  expect(findDuplicateError(turns, "The agent hit an internal error.")).toBe(1);
});
