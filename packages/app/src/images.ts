/**
 * Pulling pictures out of ACP content, and deciding who can load them.
 *
 * An agent shows an image in one of two shapes: the bytes inline (an `image`
 * block, or an embedded resource's `blob`) or a *path on the desktop* (a
 * `resource_link`, or markdown like `![](.gg/generated/plot.png)`). The first
 * the phone can paint directly; the second only the daemon can read, so it is
 * carried as a `uri` and fetched over the socket on demand.
 *
 * Tool calls matter as much as message text here: image generation tools return
 * their result as tool-call content, so an agent that "made a picture" produced
 * no message chunk at all — the reason chat showed nothing.
 *
 * Pure and React-free so both the extraction and the source rules are testable.
 */

export interface ChatImage {
  /**
   * A `data:` URI when the bytes travelled with the message, otherwise the
   * path or URL the agent named.
   */
  src: string;
  mimeType?: string;
  /** Shown while loading and read out by screen readers. */
  alt?: string;
}

export type ImageSourceKind = "inline" | "remote" | "local";

const IMAGE_EXTENSION = /\.(png|jpe?g|gif|webp|bmp|heic|heif)(?:[?#].*)?$/i;

/**
 * True for a mime type the app can render as a picture.
 *
 * SVG is excluded despite being `image/*`: React Native ships no renderer for
 * it, so it decodes to an empty frame. The daemon refuses the same format, and
 * a block trusted here purely on its mime type would otherwise skip the source
 * check below and be fetched only to fail.
 */
function isImageMime(mimeType: unknown): mimeType is string {
  return (
    typeof mimeType === "string" &&
    mimeType.startsWith("image/") &&
    !mimeType.toLowerCase().startsWith("image/svg")
  );
}

/**
 * Where the bytes for a source have to come from.
 *
 * `local` is the interesting one: a path that means nothing on the phone and
 * must be resolved through the daemon that can see that filesystem.
 */
export function imageSourceKind(src: string): ImageSourceKind {
  const value = src.trim();
  if (value.startsWith("data:")) return "inline";
  if (/^https?:\/\//i.test(value)) return "remote";
  return "local";
}

/**
 * Whether a source is worth rendering as an image at all.
 *
 * Markdown links to non-images (`file:///notes.md`) reach the image rule too;
 * treating those as pictures would ask the daemon for bytes it will refuse and
 * leave a permanent error card in the transcript.
 */
export function isDisplayableImage(src: string): boolean {
  const value = src.trim();
  if (!value) return false;
  // SVG is an image type React Native has no renderer for, so it decodes to an
  // empty frame rather than a picture. The daemon refuses it for the same
  // reason; the two halves must agree or a link is fetched only to fail.
  if (/^data:image\/svg/i.test(value)) return false;
  if (value.startsWith("data:")) return value.startsWith("data:image/");
  return IMAGE_EXTENSION.test(value.split("?")[0]!.split("#")[0]!);
}

function imageFromBlock(block: any): ChatImage | undefined {
  if (!block || typeof block !== "object") return undefined;

  if (block.type === "image") {
    // An explicit type that cannot be painted is a refusal, not a reason to
    // guess png over bytes that are demonstrably something else.
    if (block.mimeType !== undefined && !isImageMime(block.mimeType)) return undefined;
    const mimeType = isImageMime(block.mimeType) ? block.mimeType : "image/png";
    // `data` is base64 per ACP; some agents send a uri-only image instead.
    if (typeof block.data === "string" && block.data) {
      return { src: `data:${mimeType};base64,${block.data}`, mimeType };
    }
    if (typeof block.uri === "string" && block.uri) {
      return { src: block.uri, mimeType };
    }
    return undefined;
  }

  if (block.type === "resource_link") {
    const uri = typeof block.uri === "string" ? block.uri : "";
    if (!uri) return undefined;
    // A link only advertises a path, so the mime type is the only reliable
    // signal for formats the extension does not spell out.
    if (!isImageMime(block.mimeType) && !isDisplayableImage(uri)) return undefined;
    return {
      src: uri,
      mimeType: isImageMime(block.mimeType) ? block.mimeType : undefined,
      alt: typeof block.name === "string" ? block.name : undefined,
    };
  }

  if (block.type === "resource") {
    const resource = block.resource;
    if (!resource || typeof resource !== "object") return undefined;
    const mimeType = isImageMime(resource.mimeType) ? resource.mimeType : undefined;
    if (typeof resource.blob === "string" && resource.blob && mimeType) {
      return { src: `data:${mimeType};base64,${resource.blob}`, mimeType };
    }
    const uri = typeof resource.uri === "string" ? resource.uri : "";
    if (uri && (mimeType || isDisplayableImage(uri))) return { src: uri, mimeType };
    return undefined;
  }

  return undefined;
}

/** Every image in one `content` field, which may be a block or an array. */
export function imagesFromContent(content: unknown): ChatImage[] {
  const blocks = Array.isArray(content) ? content : [content];
  return blocks.map(imageFromBlock).filter((image): image is ChatImage => image !== undefined);
}

/**
 * Images produced by a tool call.
 *
 * Only images are taken. pew2 does not render tool calls as conversation, so
 * lifting their text would put file contents and command output into the
 * transcript; a generated picture is the one part that is the answer itself.
 */
export function imagesFromToolCall(update: any): ChatImage[] {
  const content = update?.content;
  if (!Array.isArray(content)) return [];
  const images: ChatImage[] = [];
  for (const entry of content) {
    if (entry?.type !== "content") continue;
    images.push(...imagesFromContent(entry.content));
  }
  return images;
}

/** Drop repeats so a tool's progress update does not restate its own picture. */
export function dedupeImages(images: readonly ChatImage[]): ChatImage[] {
  const seen = new Set<string>();
  const out: ChatImage[] = [];
  for (const image of images) {
    if (seen.has(image.src)) continue;
    seen.add(image.src);
    out.push(image);
  }
  return out;
}
