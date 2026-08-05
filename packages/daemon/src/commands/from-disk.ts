/**
 * Slash commands read from a project's own markdown files.
 *
 * ACP has a notification for this (`available_commands_update`) and an agent
 * that sends one is always believed instead — only it knows its own built-ins.
 * But not every agent sends it, and a phone that showed no commands for those
 * agents would be wrong about a project that plainly has them.
 *
 * Which directories to read is declared per provider in its manifest, so
 * supporting another agent's convention is a manifest change, not a code
 * change. Nothing here is agent-specific.
 *
 * Paths are POSIX-style in the manifest and resolved with the host's own
 * separator, so `.gg/commands` is the same declaration on Windows as on macOS.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { AvailableCommand } from "../acp/connect.js";

/**
 * Cap per provider.
 *
 * A command list is a menu, not a corpus: a directory with hundreds of files is
 * a mistake or a scratch folder, and reading all of it would spend real time on
 * the path that opens a session.
 */
const MAX_COMMANDS = 100;

/**
 * Read the one-line description a command file declares in its frontmatter.
 *
 * Deliberately not a YAML parser. A single scalar key is wanted, an agent
 * convention rather than a specification, and pulling in a parser to read it
 * would buy nothing this does not already do correctly. Anything unparseable is
 * simply no description — the command itself still works.
 *
 * The `name` field is ignored: the filename is what the user types, so a name
 * that disagreed with its own file would label a command that cannot be run.
 */
function readDescription(source: string): string {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
  if (!block) return "";
  const found = /^description:\s*(.+)$/m.exec(block[1]!);
  // Quotes around the value are common in these files, and are not part of it.
  return found?.[1]?.trim().replace(/^["']|["']$/g, "") ?? "";
}

/**
 * Commands found in one provider's declared directories.
 *
 * Best-effort by design: a missing or unreadable directory is simply no
 * commands, never an error. This runs while a session is opening, and a project
 * without a commands folder is the normal case rather than a fault.
 *
 * Earlier directories win, so a project's own copy overrides the user's global
 * one of the same name — the same precedence the agents themselves use.
 */
export async function readCommandDirs(
  dirs: string[],
  cwd: string,
): Promise<AvailableCommand[]> {
  const found = new Map<string, AvailableCommand>();

  for (const dir of dirs) {
    // Declared with forward slashes whatever the host, then joined with the
    // platform separator: `join`/`resolve` produce a backslash path on Windows
    // from the same manifest that works on macOS and Linux.
    const segments = dir.replace(/^~\//, "").split("/").filter(Boolean);
    const path = dir.startsWith("~/")
      ? join(homedir(), ...segments)
      : resolve(cwd, ...segments);

    let entries: string[];
    try {
      entries = await readdir(path);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith(".md") || found.size >= MAX_COMMANDS) continue;
      // The filename is the command: it is what the user types.
      const name = basename(entry, ".md");
      if (found.has(name)) continue;

      let source: string;
      try {
        source = await readFile(join(path, entry), "utf8");
      } catch {
        // Unreadable file: skip it rather than lose the whole directory.
        continue;
      }

      found.set(name, {
        name,
        description: readDescription(source),
      });
    }
  }

  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}
