import { expect, test } from "bun:test";
import { composerAction } from "./composerAction";

test.each([
  { busy: true, canSend: true, expected: "queue" },
  { busy: true, canSend: false, expected: "stop" },
  { busy: false, canSend: true, expected: "send" },
  { busy: false, canSend: false, expected: "none" },
] as const)("composer action: $expected", ({ busy, canSend, expected }) => {
  expect(composerAction(busy, canSend)).toBe(expected);
});
