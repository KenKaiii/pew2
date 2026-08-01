import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCommandDirs } from "./from-disk.js";

async function project(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), "pew2-cmds-"));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, body);
  }
  return root;
}

const withFrontMatter = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\nBody text.\n`;

test("reads a command and its description from frontmatter", async () => {
  const root = await project({
    ".gg/commands/commit.md": withFrontMatter("commit", "Run checks and commit"),
  });

  expect(await readCommandDirs([".gg/commands"], root)).toEqual([
    { name: "commit", description: "Run checks and commit" },
  ]);
});

test("uses the filename, which is what the user actually types", async () => {
  // A `name` that disagrees with its own file would name a command that cannot
  // be run, so the filename wins.
  const root = await project({
    ".gg/commands/deploy.md": withFrontMatter("something-else", "Ship it"),
  });

  expect((await readCommandDirs([".gg/commands"], root))[0]?.name).toBe("deploy");
});

test("a file without frontmatter is still a command", async () => {
  const root = await project({ ".gg/commands/plain.md": "Just a prompt.\n" });

  expect(await readCommandDirs([".gg/commands"], root)).toEqual([
    { name: "plain", description: "" },
  ]);
});

test("ignores anything that is not markdown", async () => {
  const root = await project({
    ".gg/commands/notes.txt": "not a command",
    ".gg/commands/real.md": withFrontMatter("real", "A command"),
  });

  expect((await readCommandDirs([".gg/commands"], root)).map((c) => c.name)).toEqual([
    "real",
  ]);
});

test("a missing directory is no commands, never an error", async () => {
  const root = await project({});

  // This runs while a session opens, and a project with no commands folder is
  // the normal case rather than a fault.
  expect(await readCommandDirs([".gg/commands", "~/nope-does-not-exist"], root)).toEqual(
    [],
  );
});

test("no configured directories means no work", async () => {
  expect(await readCommandDirs([], await project({}))).toEqual([]);
});

test("an earlier directory wins, so a project overrides a shared copy", async () => {
  const root = await project({
    ".gg/commands/commit.md": withFrontMatter("commit", "Project version"),
    "shared/commands/commit.md": withFrontMatter("commit", "Shared version"),
  });

  const commands = await readCommandDirs([".gg/commands", "shared/commands"], root);
  expect(commands).toHaveLength(1);
  expect(commands[0]?.description).toBe("Project version");
});

test("strips quotes and returns names sorted", async () => {
  const root = await project({
    ".gg/commands/zebra.md": `---\ndescription: "Quoted description"\n---\n`,
    ".gg/commands/alpha.md": withFrontMatter("alpha", "First"),
  });

  const commands = await readCommandDirs([".gg/commands"], root);
  expect(commands.map((c) => c.name)).toEqual(["alpha", "zebra"]);
  expect(commands[1]?.description).toBe("Quoted description");
});
