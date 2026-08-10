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
  // Both separators, because this string was written by the *daemon's* platform
  // and not the phone's. A Windows desktop sends `D:\code\pew2`, which split on
  // "/" alone is a single long segment — so the drawer printed the entire path
  // under every conversation, which is the exact noise this function exists to
  // remove. `node:path` would not help: the phone is always POSIX, and it is the
  // sender's convention that has to be understood here.
  //
  // Trailing separators would make the last segment empty: "/repo/" -> "repo".
  const segments = cwd.split(/[/\\]/).filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  // A bare drive root (`D:\`) has no folder to name, and "D:" reads as a typo.
  if (last && /^[a-zA-Z]:$/.test(last)) return undefined;
  return last;
}
