/**
 * The folder a conversation belongs to, for the drawer's session rows.
 *
 * A full path (`/Users/kenkai/gg-projects/pew2`) is noise in a 44pt row; the
 * folder name alone (`pew2`) is how people actually tell their projects apart.
 * Pure so the edge cases stay testable.
 */

/** Last meaningful segment of a path, or undefined when there isn't one. */
export function folderName(cwd: string | undefined): string | undefined {
  if (!cwd) return undefined;
  // Trailing slashes would make the last segment empty: "/repo/" -> "repo".
  const segments = cwd.split("/").filter((segment) => segment.length > 0);
  return segments[segments.length - 1];
}
