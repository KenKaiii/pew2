import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isEmptyTurn } from "../chunks";

// Native rendering needs a device; this source contract prevents the list from
// discarding an image-only turn before the cell can show its queue controls.
test("the transcript and cell both retain image-only queued messages", () => {
  const thread = readFileSync(join(import.meta.dir, "ChatThread.tsx"), "utf8");
  expect(thread).toContain("if (isEmptyTurn(item)) return null;");
  const turn = readFileSync(join(import.meta.dir, "Turn.tsx"), "utf8");
  expect(turn).toContain("if (isEmptyTurn(turn)) return null;");
  expect(isEmptyTurn({ role: "user", text: "", images: [{ src: "file:///photo.jpg", origin: "device" }] })).toBe(false);
  expect(turn).toContain("Cancel queued message");
});
