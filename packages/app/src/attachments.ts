/**
 * Files staged on the phone, waiting to go out with the next prompt.
 *
 * The rules here are the ones worth testing away from any picker SDK: what
 * counts as a picture, what the limits are, and how a rejection is worded. The
 * Expo bindings live in `ui/attachmentPicker.ts`, so this module stays
 * importable by `bun test` (which cannot parse React Native's Flow syntax).
 *
 * The limits are duplicated from `@pew2/protocol` rather than imported, and
 * that is deliberate: Metro cannot resolve that package's `.js`-suffixed TS
 * imports, so importing it fails the *bundle*, not just a type check. The
 * daemon holds the authoritative copy and re-checks every prompt — these exist
 * so the phone can explain the problem before spending a minute uploading
 * something that will be refused.
 */
import type { ChatImage } from "./images";

/** Keep in step with `packages/protocol/src/wire.ts`. */
export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 12 * 1024 * 1024;

/** One staged file, before it becomes a `PromptAttachment` on the wire. */
export interface PendingAttachment {
  /** Stable across re-renders, so a chip keeps its identity while the list changes. */
  id: string;
  name: string;
  mimeType: string;
  /** Base64, no `data:` prefix — the shape the wire wants. */
  data: string;
  size: number;
  /**
   * Where the file sits on *this device*, for showing a thumbnail without
   * decoding megabytes of base64 into a string prop.
   */
  localUri?: string;
}

/**
 * Whether this file should be shown as a picture rather than a file chip.
 *
 * SVG is excluded despite being `image/*`: React Native ships no renderer for
 * it, so it would reserve a permanently empty frame. `images.ts` refuses the
 * same format for the same reason, and the two must agree — a device
 * attachment bypasses the `isDisplayableImage` check, since a photo picked from
 * a library is a picture whatever its extension says.
 */
export function isImageAttachment(attachment: PendingAttachment): boolean {
  const type = attachment.mimeType.toLowerCase();
  return type.startsWith("image/") && !type.startsWith("image/svg");
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Why `incoming` cannot be added to `existing`, or undefined when it can.
 *
 * Phrased for a person rather than a log: the answer to "why did nothing
 * happen" has to be on screen, and it has to name the file.
 */
export function attachmentRejection(
  existing: readonly PendingAttachment[],
  incoming: readonly PendingAttachment[],
): string | undefined {
  if (incoming.length === 0) return undefined;

  if (existing.length + incoming.length > MAX_ATTACHMENTS) {
    const room = Math.max(0, MAX_ATTACHMENTS - existing.length);
    return room === 0
      ? `You can attach ${MAX_ATTACHMENTS} files to a message.`
      : room === 1
        ? "Only 1 more file fits in this message."
        : `Only ${room} more files fit in this message.`;
  }

  for (const file of incoming) {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      return `${file.name} is ${megabytes(file.size)}. The limit is ${megabytes(
        MAX_ATTACHMENT_BYTES,
      )} per file.`;
    }
  }

  const total = [...existing, ...incoming].reduce((sum, file) => sum + file.size, 0);
  if (total > MAX_ATTACHMENTS_TOTAL_BYTES) {
    return `That would be ${megabytes(total)} in one message. The limit is ${megabytes(
      MAX_ATTACHMENTS_TOTAL_BYTES,
    )}.`;
  }

  return undefined;
}

/**
 * Add what fits, and say what did not.
 *
 * Returns the list unchanged alongside a reason rather than throwing: picking
 * an oversized photo is an ordinary thing to do, not an error condition.
 */
export function addAttachments(
  existing: readonly PendingAttachment[],
  incoming: readonly PendingAttachment[],
): { attachments: PendingAttachment[]; rejected?: string } {
  const rejected = attachmentRejection(existing, incoming);
  if (rejected) return { attachments: [...existing], rejected };
  return { attachments: [...existing, ...incoming] };
}

/** The shape `session.prompt` carries. Mirrors `wire.PromptAttachment`. */
export interface WireAttachment {
  name: string;
  mimeType: string;
  data: string;
}

/** The wire form: `localUri` and `id` are this device's business only. */
export function toWireAttachments(
  attachments: readonly PendingAttachment[],
): WireAttachment[] {
  return attachments.map(({ name, mimeType, data }) => ({ name, mimeType, data }));
}

/**
 * The pictures among them, for the optimistic turn.
 *
 * `origin: "device"` matters: these `file://` URIs are on the *phone*, while an
 * identical-looking URI from an agent is on the desktop and must be fetched
 * through the daemon. The scheme cannot tell those apart, so the distinction is
 * recorded rather than inferred.
 */
export function attachmentImages(attachments: readonly PendingAttachment[]): ChatImage[] {
  return attachments.filter(isImageAttachment).map((file) => ({
    src: file.localUri ?? `data:${file.mimeType};base64,${file.data}`,
    mimeType: file.mimeType,
    alt: file.name,
    origin: file.localUri ? ("device" as const) : undefined,
  }));
}

/** A short, human size for a chip: "412 KB". */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
