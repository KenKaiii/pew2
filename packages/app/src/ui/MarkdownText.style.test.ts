import { expect, test } from "bun:test";
import { fencedCodeContainerStyle, fencedCodeTextStyle } from "./markdownCodeStyles";

test("fenced code explicitly overrides the renderer's GitHub-light background", () => {
  expect(fencedCodeTextStyle.backgroundColor).toBe("transparent");
  expect(fencedCodeTextStyle.backgroundColor).not.toBe("#f6f8fa");
});

test("fenced code is bounded to the message rail and wraps instead of scrolling", () => {
  expect(fencedCodeContainerStyle).toMatchObject({
    width: "100%",
    maxWidth: "100%",
    minWidth: 0,
    overflow: "hidden",
  });
  expect(fencedCodeTextStyle).toMatchObject({
    width: "100%",
    maxWidth: "100%",
    minWidth: 0,
    flexShrink: 1,
  });
});
