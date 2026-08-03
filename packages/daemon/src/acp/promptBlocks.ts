/**
 * Choosing how to hand an attachment to an agent.
 *
 * ACP offers three ways to put a file in a prompt and agents support different
 * subsets, advertised as `promptCapabilities` on `initialize`. Sending a block
 * an agent never claimed is a protocol error, so the choice is made from the
 * capabilities rather than assumed:
 *
 * - **`image`** — the pixels, inline. The only form where the model actually
 *   *sees* a screenshot rather than being told a path exists.
 * - **`resource`** — text, inline (`embeddedContext`). Saves the agent a tool
 *   call for a small file it would otherwise have to go and read.
 * - **`resource_link`** — just a path. Requires no capability at all, because
 *   the daemon really did write the file and the agent's own Read tool can open
 *   it.
 *
 * A link is *advisory*, though, and that is not a detail: GG Coder answers "I
 * can't see an attached file" to a prompt whose `resource_link` names a file it
 * could perfectly well have read. So whenever an attachment is delivered as a
 * link rather than as content, its path is stated in the text as well — the one
 * block type every agent is obliged to handle. Without that, attaching a file
 * to an agent with no image support silently did nothing.
 *
 * Pure and separately testable: the block choice is the part with rules, and
 * `connect.ts` should not grow a third concern.
 */
import type { StoredAttachment } from "../attachments.js";

/** What the agent said it accepts in a prompt. Absent fields mean "no". */
export interface PromptCapabilities {
  image?: boolean;
  audio?: boolean;
  embeddedContext?: boolean;
}

/**
 * Above this a file is a link rather than inline text.
 *
 * Embedded context is spent from the model's window whether it turns out to be
 * relevant or not; past a few hundred lines the agent is better off reading the
 * parts it wants.
 */
export const MAX_EMBEDDED_TEXT_BYTES = 256 * 1024;

/**
 * Types that are text an agent can use, beyond the `text/*` tree.
 *
 * A `.json` or `.patch` file is as readable as prose but is not typed as text,
 * and being handed one as an opaque link is a wasted tool call.
 */
const TEXTUAL_MIME = new Set([
  "application/json",
  "application/xml",
  "application/x-yaml",
  "application/yaml",
  "application/javascript",
  "application/typescript",
  "application/x-sh",
  "application/sql",
  "application/x-patch",
]);

export function isTextualMime(mimeType: string): boolean {
  const type = mimeType.split(";")[0]!.trim().toLowerCase();
  return type.startsWith("text/") || TEXTUAL_MIME.has(type) || type.endsWith("+json") ||
    type.endsWith("+xml");
}

export function isImageMime(mimeType: string): boolean {
  return mimeType.split(";")[0]!.trim().toLowerCase().startsWith("image/");
}

/** A `file://` URL for an absolute path, for the `uri` every block form carries. */
export function fileUri(path: string): string {
  // Not `pathToFileURL`: the segments are already sanitised, and this keeps the
  // module free of node-only imports so it stays trivially testable.
  const encoded = path.split("/").map(encodeURIComponent).join("/");
  return `file://${encoded.startsWith("/") ? "" : "/"}${encoded}`;
}

export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string; uri?: string }
  | {
      type: "resource";
      resource: { uri: string; mimeType: string; text: string };
    }
  | { type: "resource_link"; uri: string; name: string; mimeType: string; size: number };

/**
 * The block for one stored attachment.
 *
 * An image carries `uri` beside its bytes on purpose: the model sees the
 * picture *and* the agent knows the path, so "crop the top of that screenshot"
 * has something to act on.
 */
export function attachmentBlock(
  attachment: StoredAttachment,
  capabilities: PromptCapabilities | undefined,
): PromptBlock {
  const uri = fileUri(attachment.path);

  if (capabilities?.image && isImageMime(attachment.mimeType)) {
    return { type: "image", mimeType: attachment.mimeType, data: attachment.data, uri };
  }

  if (
    capabilities?.embeddedContext &&
    isTextualMime(attachment.mimeType) &&
    attachment.size <= MAX_EMBEDDED_TEXT_BYTES
  ) {
    return {
      type: "resource",
      resource: {
        uri,
        mimeType: attachment.mimeType,
        text: Buffer.from(attachment.data, "base64").toString("utf8"),
      },
    };
  }

  return {
    type: "resource_link",
    uri,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
  };
}

/**
 * A filename as one line of prose.
 *
 * The name is whatever the phone sent, and it is being pasted into the prompt
 * the model reads. A name carrying newlines could forge extra list entries or
 * instructions below them, so all whitespace collapses to single spaces — the
 * *path* beside it is the sanitised one the daemon actually wrote.
 */
function labelFor(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 120) || "file";
}

/**
 * The full `prompt` array for a turn.
 *
 * Text first: the instruction is what the attachments are *for*, and an agent
 * reading blocks in order should meet the question before the evidence.
 */
export function promptBlocks(
  text: string,
  attachments: readonly StoredAttachment[],
  capabilities: PromptCapabilities | undefined,
): PromptBlock[] {
  const blocks = attachments.map((attachment) => attachmentBlock(attachment, capabilities));

  // Anything delivered as a bare link is named in the text too, since an agent
  // is free to ignore a link block and at least one does.
  const linked = attachments.filter((_, index) => blocks[index]!.type === "resource_link");
  const preamble =
    linked.length === 0
      ? ""
      : `${linked.length === 1 ? "Attached file" : "Attached files"} (saved to disk):\n` +
        linked.map((file) => `- ${labelFor(file.name)}: ${file.path}`).join("\n");

  const body = preamble && text ? `${preamble}\n\n${text}` : preamble || text;

  // An attachment sent with no words is a real message ("look at this"), but an
  // empty text block is not something every agent tolerates.
  return body.length > 0 || attachments.length === 0
    ? [{ type: "text", text: body }, ...blocks]
    : blocks;
}
