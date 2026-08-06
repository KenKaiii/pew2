/**
 * Files the *phone* is sending to the agent.
 *
 * The mirror image of `images.ts`. That module exists because the phone cannot
 * read the desktop's disk; this one exists because the desktop cannot read the
 * phone's camera roll. Bytes arrive inlined in `session.prompt`, get written
 * somewhere the agent can open, and are then referenced by path.
 *
 * Two rules earn their own module:
 *
 * - **Not in the project directory.** An agent's cwd is a git repo, and the
 *   context row above the composer counts uncommitted files. Dropping a photo
 *   into it would report the user's own attachment as a pending change, and
 *   `git add .` would commit it. They go to a per-session directory under the
 *   system tempdir instead — which `allowedImageRoots()` already permits, so
 *   the echoed copy renders through the existing `image.fetch` path with no new
 *   containment rule to keep in sync.
 * - **The name comes off a phone.** It is a display label, not a path: every
 *   separator becomes an underscore, runs of dots collapse, and the result is
 *   length-capped, so no attachment can be written outside its session's
 *   directory.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { wire } from "@pew2/protocol";

const { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS_TOTAL_BYTES } = wire;
type PromptAttachment = wire.PromptAttachment;

/** Where a session's attachments live. One directory per session, so closing one cleans up. */
export function attachmentDir(sessionId: string, root: string = tmpdir()): string {
  return join(root, "pew2-attachments", safeSegment(sessionId, "session"));
}

/**
 * One path segment that cannot escape its parent.
 *
 * Everything outside a conservative allowlist becomes `_`, which disposes of
 * separators, NUL and the Windows reserved characters in one pass. Runs of dots
 * then collapse to one, which is what actually removes `..` — stripping only a
 * leading `..` still leaves `.._.._etc` for a name like `../../etc`.
 *
 * A result with no letter or digit left in it (`/`, `..`, `___`) is not a name
 * anyone can read, and an empty one would resolve to the parent directory, so
 * both fall back to the caller's placeholder.
 */
export function safeSegment(name: string, fallback: string): string {
  const cleaned = name
    .trim()
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/\.{2,}/g, ".")
    // A leading dot hides the file, which an attachment has no reason to do.
    .replace(/^\.+/, "")
    .slice(0, 64);
  return /[A-Za-z0-9]/.test(cleaned) ? cleaned : fallback;
}

/**
 * The filename an attachment is written under.
 *
 * Prefixed with its index in the prompt: two photos picked from a camera roll
 * are very often both `image.jpg`, and the second must not overwrite the first
 * before the agent has read it.
 */
export function attachmentFileName(name: string, index: number): string {
  return `${index}-${safeSegment(name, `attachment${extname(name) || ""}`)}`;
}

/** Bytes an attachment occupies once decoded, without decoding it. */
export function base64Bytes(data: string): number {
  const len = data.length;
  if (len === 0) return 0;
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  return Math.max(0, (len * 3) / 4 - padding);
}

/**
 * Why this set of attachments cannot be sent, or undefined when it can.
 *
 * The app checks the same limits so it can explain them before a send; this is
 * the check that matters, because a daemon cannot trust a client. Shared
 * wording means both halves say the same thing.
 */
export function attachmentLimitError(
  attachments: readonly PromptAttachment[],
): string | undefined {
  if (attachments.length > MAX_ATTACHMENTS) {
    return `Too many attachments: ${attachments.length}, limit is ${MAX_ATTACHMENTS}.`;
  }
  let total = 0;
  for (const attachment of attachments) {
    const size = base64Bytes(attachment.data);
    total += size;
    if (size > MAX_ATTACHMENT_BYTES) {
      return `'${attachment.name}' is ${megabytes(size)}, over the ${megabytes(
        MAX_ATTACHMENT_BYTES,
      )} limit for one file.`;
    }
  }
  if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
    return `Attachments total ${megabytes(total)}, over the ${megabytes(
      MAX_ATTACHMENTS_TOTAL_BYTES,
    )} limit for one message.`;
  }
  return undefined;
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/** An attachment once it exists on this disk. */
export interface StoredAttachment {
  name: string;
  mimeType: string;
  /** Absolute path on the machine running the agent. */
  path: string;
  size: number;
  /** Kept for building the prompt block; the agent may want the bytes inline. */
  data: string;
}

/**
 * Write a prompt's attachments to disk and describe where they landed.
 *
 * Throws on a limit breach rather than silently truncating: a prompt that
 * mentions "the screenshot" is worse than useless once the screenshot has been
 * quietly dropped.
 */
export async function storeAttachments(
  sessionId: string,
  attachments: readonly PromptAttachment[],
  root: string = tmpdir(),
): Promise<StoredAttachment[]> {
  if (attachments.length === 0) return [];
  const limit = attachmentLimitError(attachments);
  if (limit) throw new Error(limit);

  const dir = attachmentDir(sessionId, root);
  // Owner-only. The default lands at 0755/0644 in a shared temp directory, under
  // a path anyone can work out from a session id — so every other local account
  // could read the photos and screenshots someone sent to their own machine.
  // `image.fetch` allows this directory as a root as well, which made them
  // reachable over the wire rather than only on the box.
  await mkdir(dir, { recursive: true, mode: 0o700 });

  const stored: StoredAttachment[] = [];
  for (const [index, attachment] of attachments.entries()) {
    const path = join(dir, attachmentFileName(attachment.name, index));
    const bytes = Buffer.from(attachment.data, "base64");
    await writeFile(path, bytes, { mode: 0o600 });
    stored.push({
      name: attachment.name,
      mimeType: attachment.mimeType,
      path,
      size: bytes.byteLength,
      data: attachment.data,
    });
  }
  return stored;
}

/**
 * Drop a session's attachments.
 *
 * Best effort: these are in the tempdir, so failing to remove them costs disk
 * the OS will reclaim anyway, and must never take a session close down with it.
 */
export async function discardAttachments(
  sessionId: string,
  root: string = tmpdir(),
): Promise<void> {
  await rm(attachmentDir(sessionId, root), { recursive: true, force: true }).catch(() => {});
}
