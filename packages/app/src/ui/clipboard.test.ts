import { expect, mock, test } from "bun:test";
import { writeToClipboard } from "./clipboard";

test("writes exactly what was displayed, unchanged", async () => {
  const writeText = mock(async () => true);

  await expect(writeToClipboard("const answer = 42;", writeText)).resolves.toBe(true);
  expect(writeText).toHaveBeenCalledTimes(1);
  expect(writeText).toHaveBeenCalledWith("const answer = 42;");
});

test("reports clipboard failures without rejecting the press", async () => {
  const writeText = mock(async () => {
    throw new Error("clipboard unavailable");
  });

  await expect(writeToClipboard("echo safe", writeText)).resolves.toBe(false);
});

test("a message keeps its markdown, its blank lines and its trailing newline", async () => {
  // What the message sheet shows *is* what it copies — the source, not the
  // rendering — so a reply pasted into an editor arrives as the markdown the
  // agent wrote. Anything trimming or normalising here would silently make the
  // paste differ from the text under the user's finger.
  const reply = "# Heading\n\n- **bold** item\n\n```ts\nconst x = 1;\n```\n";
  const writeText = mock(async () => true);

  await expect(writeToClipboard(reply, writeText)).resolves.toBe(true);
  expect(writeText).toHaveBeenCalledWith(reply);
});
