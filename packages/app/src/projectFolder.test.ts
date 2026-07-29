import { expect, test } from "bun:test";
import { folderName } from "./projectFolder";

test("a full path reduces to its folder", () => {
  expect(folderName("/Users/kenkai/gg-projects/pew2")).toBe("pew2");
  expect(folderName("/home/ken/work/gg-framework")).toBe("gg-framework");
});

test("a trailing slash does not produce an empty name", () => {
  expect(folderName("/Users/kenkai/pew2/")).toBe("pew2");
});

test("the filesystem root and empty input have no folder", () => {
  expect(folderName("/")).toBeUndefined();
  expect(folderName("")).toBeUndefined();
  expect(folderName(undefined)).toBeUndefined();
});

test("a relative path uses its last segment", () => {
  expect(folderName("gg-projects/pew2")).toBe("pew2");
  expect(folderName("pew2")).toBe("pew2");
});
