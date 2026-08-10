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

test("a Windows desktop's path shows the folder, not the whole drive path", () => {
  // The daemon runs on the user's machine and the app runs on a phone, so this
  // string arrives in the *sender's* convention. Split on "/" alone, a Windows
  // path is one long segment, and the drawer printed `D:\code\pew2` under every
  // conversation — the precise noise this function exists to remove.
  expect(folderName("D:\\code\\pew2")).toBe("pew2");
  expect(folderName("C:\\Users\\ken\\projects\\api\\")).toBe("api");
  // Mixed separators are normal on Windows: most APIs accept either.
  expect(folderName("C:/Users/ken/work")).toBe("work");
  // A drive root names no folder, and "D:" on screen reads as a typo.
  expect(folderName("D:\\")).toBeUndefined();
  // A UNC share still names its last segment.
  expect(folderName("\\\\build-server\\share\\pew2")).toBe("pew2");
});
