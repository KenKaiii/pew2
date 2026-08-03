import { expect, test } from "bun:test";
import { projectLabel, projectsForProvider, sessionsInProject } from "./projects";
import type { Session } from "./useDaemon";

function session(partial: Partial<Session> & { id: string }): Session {
  return {
    providerId: "claude-code",
    title: "A conversation",
    startedAt: 0,
    turns: [],
    configOptions: [],
    ...partial,
  };
}

test("the daemon's list is used as announced, newest project first", () => {
  const projects = projectsForProvider(
    [
      { path: "/a/site", name: "site", sessions: 2, updatedAt: "2026-07-01T00:00:00Z" },
      { path: "/a/pew2", name: "pew2", sessions: 9, updatedAt: "2026-08-01T00:00:00Z" },
    ],
    [],
    "claude-code",
  );

  expect(projects.map((p) => p.name)).toEqual(["pew2", "site"]);
  expect(projects[0]!.sessions).toBe(9);
});

test("a project seen only in the sessions on screen is still offered", () => {
  const projects = projectsForProvider(
    [],
    [session({ id: "1", cwd: "/a/fresh" })],
    "claude-code",
  );

  expect(projects.map((p) => p.name)).toEqual(["fresh"]);
});

test("a project used a minute ago sorts above the agent's dated ones", () => {
  // It has no announced stamp of its own, and undated would put the most
  // recent work last in a menu that promises newest first.
  const projects = projectsForProvider(
    [{ path: "/a/old", name: "old", updatedAt: "2020-01-01T00:00:00Z" }],
    [session({ id: "1", cwd: "/a/fresh", startedAt: Date.now() })],
    "claude-code",
  );

  expect(projects.map((p) => p.name)).toEqual(["fresh", "old"]);
});

test("another agent's projects are never offered under this one", () => {
  const projects = projectsForProvider(
    [],
    [session({ id: "1", cwd: "/a/other", providerId: "codex" })],
    "claude-code",
  );

  expect(projects).toEqual([]);
});

test("a project in both sources is listed once, keeping the daemon's count", () => {
  const projects = projectsForProvider(
    [{ path: "/a/pew2", name: "pew2", sessions: 12 }],
    [session({ id: "1", cwd: "/a/pew2" })],
    "claude-code",
  );

  expect(projects).toHaveLength(1);
  expect(projects[0]!.sessions).toBe(12);
});

test("choosing a project keeps only its conversations", () => {
  const sessions = [
    session({ id: "1", cwd: "/a/pew2" }),
    session({ id: "2", cwd: "/a/site" }),
  ];

  const kept = sessionsInProject(sessions, { path: "/a/pew2", name: "pew2" });
  expect(kept.map((s) => s.id)).toEqual(["1"]);
});

test("a conversation started on this phone matches by the folder the daemon stamped", () => {
  // It never had a `cwd` of its own; without this fallback it would vanish out
  // of the very project it was started in.
  const local = session({ id: "1", folder: "pew2" });

  expect(sessionsInProject([local], { path: "/a/pew2", name: "pew2" })).toHaveLength(1);
  expect(sessionsInProject([local], { path: "/a/site", name: "site" })).toHaveLength(0);
});

test("a session with neither path nor folder is not claimed by a project", () => {
  expect(sessionsInProject([session({ id: "1" })], { path: "/a/pew2", name: "pew2" })).toEqual([]);
});

test("no choice shows everything", () => {
  const sessions = [session({ id: "1", cwd: "/a/pew2" }), session({ id: "2" })];
  expect(sessionsInProject(sessions, undefined)).toHaveLength(2);
});

test("the control always has a label", () => {
  expect(projectLabel(undefined)).toBe("All projects");
  expect(projectLabel({ path: "/a/pew2", name: "pew2" })).toBe("pew2");
});
