/**
 * The record of projects a client has opened.
 *
 * Small, but it is the thing standing between "I picked this repo yesterday"
 * and a daemon that refuses the path because it restarted overnight.
 */
import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  KNOWN_PROJECT_LIMIT,
  readKnownProjects,
  rememberKnownProject,
} from "./known-projects.js";

async function scratch(): Promise<NodeJS.ProcessEnv> {
  return { PEW2_HOME: await mkdtemp(join(tmpdir(), "pew2-known-")) };
}

test("a project survives the process that stored it", async () => {
  const env = await scratch();
  expect(await readKnownProjects(env)).toEqual([]);

  await rememberKnownProject("/Users/someone/code/api", env);

  expect(await readKnownProjects(env)).toEqual(["/Users/someone/code/api"]);
});

test("storing the same project twice keeps one entry, freshly", async () => {
  const env = await scratch();

  await rememberKnownProject("/a", env);
  await rememberKnownProject("/b", env);
  await rememberKnownProject("/a", env);

  // Newest last: the cap drops what nobody has opened in longest, and "/a" was
  // just used.
  expect(await readKnownProjects(env)).toEqual(["/b", "/a"]);
});

test("a second daemon adds to the list instead of replacing it", async () => {
  // Two daemons on one machine is ordinary — an installed one beside a
  // development one, or an update starting under a running app. The file is
  // written here as the *other* process left it, which is the only way to tell
  // read-modify-write apart from a blind overwrite: a blind write would drop
  // every project the other daemon had accepted.
  const env = await scratch();
  await writeFile(
    join(env.PEW2_HOME!, "known-projects.json"),
    JSON.stringify(["/from-the-other-daemon"]),
    "utf8",
  );

  await rememberKnownProject("/from-this-one", env);

  expect(await readKnownProjects(env)).toEqual(["/from-the-other-daemon", "/from-this-one"]);
});

test("the list is capped, oldest first", async () => {
  const env = await scratch();

  for (let i = 0; i < KNOWN_PROJECT_LIMIT + 5; i++) {
    await rememberKnownProject(`/project-${i}`, env);
  }

  const stored = await readKnownProjects(env);
  expect(stored).toHaveLength(KNOWN_PROJECT_LIMIT);
  expect(stored[0]).toBe("/project-5");
  expect(stored.at(-1)).toBe(`/project-${KNOWN_PROJECT_LIMIT + 4}`);
});

test("an unreadable file is a miss, not a failure", async () => {
  // This file only ever *widens* what is recognised, so losing it costs a
  // re-pick. Throwing here would instead take out session start, which is the
  // one thing that must keep working.
  const env = await scratch();
  await writeFile(join(env.PEW2_HOME!, "known-projects.json"), "{ not json", "utf8");

  expect(await readKnownProjects(env)).toEqual([]);

  await rememberKnownProject("/Users/someone/code/api", env);
  expect(await readKnownProjects(env)).toEqual(["/Users/someone/code/api"]);
});

test("entries that are not paths are dropped rather than trusted", async () => {
  const env = await scratch();
  await writeFile(
    join(env.PEW2_HOME!, "known-projects.json"),
    JSON.stringify(["/real", 7, null, { cwd: "/nope" }]),
    "utf8",
  );

  expect(await readKnownProjects(env)).toEqual(["/real"]);
});
