import { expect, test } from "bun:test";
import { foldProjects, sessionsInProject } from "./projects.js";

test("a project is counted once however many conversations it holds", () => {
  const projects = foldProjects([
    { cwd: "/Users/x/code/pew2", updatedAt: "2026-08-01T10:00:00Z" },
    { cwd: "/Users/x/code/pew2", updatedAt: "2026-07-30T10:00:00Z" },
    { cwd: "/Users/x/code/site", updatedAt: "2026-07-31T10:00:00Z" },
  ]);

  expect(projects.map((p) => [p.name, p.sessions])).toEqual([
    ["pew2", 2],
    ["site", 1],
  ]);
});

test("projects order by their newest conversation, not by the first row seen", () => {
  const projects = foldProjects([
    { cwd: "/a/old", updatedAt: "2026-01-01T00:00:00Z" },
    { cwd: "/a/new", updatedAt: "2026-08-01T00:00:00Z" },
  ]);

  expect(projects[0]!.name).toBe("new");
});

test("a project's stamp is the newest of its sessions even when a later row is the dated one", () => {
  const [project] = foldProjects([
    { cwd: "/a/repo" },
    { cwd: "/a/repo", updatedAt: "2026-08-01T00:00:00Z" },
  ]);

  expect(project!.updatedAt).toBe("2026-08-01T00:00:00Z");
});

test("sessions with no project are skipped rather than listed as a nameless row", () => {
  expect(foldProjects([{ cwd: "" }, { cwd: "   " }])).toEqual([]);
});

test("choosing a project lists only its own conversations, capped", () => {
  const sessions = [
    { sessionId: "1", cwd: "/a/one" },
    { sessionId: "2", cwd: "/a/two" },
    { sessionId: "3", cwd: "/a/one" },
  ];

  expect(sessionsInProject(sessions, "/a/one", 30).map((s) => s.sessionId)).toEqual(["1", "3"]);
  expect(sessionsInProject(sessions, "/a/one", 1).map((s) => s.sessionId)).toEqual(["1"]);
});
