import { expect, test } from "bun:test";
import { folderName, resolveWorkspace } from "./workspace.js";

const env = {} as NodeJS.ProcessEnv;

test("an explicit request always wins", () => {
  expect(resolveWorkspace("/tmp/project", { PEW2_WORKSPACE: "/env" }, "/", "/home/u")).toBe(
    "/tmp/project",
  );
});

test("PEW2_WORKSPACE overrides the daemon cwd", () => {
  expect(resolveWorkspace(undefined, { PEW2_WORKSPACE: "/srv/work" }, "/repo", "/home/u")).toBe(
    "/srv/work",
  );
});

test("a filesystem root falls back to the home directory", () => {
  // The launchd case: cwd is "/", and agents must not treat it as a project.
  expect(resolveWorkspace(undefined, env, "/", "/Users/kenkai")).toBe("/Users/kenkai");
});

test("a missing daemon cwd falls back to the home directory", () => {
  expect(resolveWorkspace(undefined, env, "/gone/since/boot", "/Users/kenkai")).toBe(
    "/Users/kenkai",
  );
});

test("an ordinary daemon cwd is kept", () => {
  expect(resolveWorkspace(undefined, env, process.cwd(), "/home/u")).toBe(process.cwd());
});

test("names a project by its last path segment, for the finished-turn banner", () => {
  expect(folderName("/Users/kenkai/gg-projects/pew2")).toBe("pew2");
  // A trailing slash must not produce an empty name.
  expect(folderName("/Users/kenkai/gg-projects/pew2/")).toBe("pew2");
});

test("no path means no project name, rather than a slash", () => {
  expect(folderName(undefined)).toBeUndefined();
  expect(folderName("/")).toBeUndefined();
});
