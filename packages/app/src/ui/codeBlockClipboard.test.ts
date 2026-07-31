import { expect, mock, test } from "bun:test";
import { writeCodeToClipboard } from "./codeBlockClipboard";

test("writes the displayed code to the clipboard", async () => {
  const writeText = mock(async () => true);

  await expect(writeCodeToClipboard("const answer = 42;", writeText)).resolves.toBe(true);
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText).toHaveBeenCalledWith("const answer = 42;");
});

test("reports clipboard failures without rejecting the press", async () => {
  const writeText = mock(async () => {
    throw new Error("clipboard unavailable");
  });

  await expect(writeCodeToClipboard("echo safe", writeText)).resolves.toBe(false);
});
