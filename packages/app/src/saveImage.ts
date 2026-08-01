/**
 * Deciding *what* to save when a picture is put in the camera roll.
 *
 * Kept Expo-free so it stays testable under `bun test`, which cannot parse
 * React Native's Flow syntax: `ui/imageSaver.ts` binds the native SDKs, this
 * half owns the naming and the data-URI parsing.
 *
 * The file name matters more than it looks. An agent's picture is `image.png`
 * on the desktop, or has no name at all when the bytes arrived inline, and a
 * camera roll full of `image.png` is a camera roll you cannot search. Every
 * saved file therefore carries the agent's own name when it had one, and a
 * timestamp when it did not.
 */

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/heic": "heic",
  "image/heif": "heif",
};

export interface ParsedDataUri {
  mimeType: string;
  base64: string;
}

/** Split `data:image/png;base64,AAA` into its parts, or undefined if it isn't one. */
export function parseDataUri(uri: string): ParsedDataUri | undefined {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(uri.trim());
  if (!match) return undefined;
  return { mimeType: match[1]!, base64: match[2]! };
}

/** The extension for a mime type, defaulting to png rather than nothing. */
export function extensionForMime(mimeType: string | undefined): string {
  return EXTENSION_BY_MIME[(mimeType ?? "").toLowerCase()] ?? "png";
}

/**
 * The extension to save under.
 *
 * The mime type wins when there is one, since it describes the actual bytes. A
 * remote URL usually has none — nothing has been downloaded yet — so its own
 * extension is trusted ahead of the png default, which would otherwise save a
 * `.webp` as a `.png` that some galleries refuse to import.
 */
function extensionFor(src: string, mimeType: string | undefined): string {
  if (mimeType && EXTENSION_BY_MIME[mimeType.toLowerCase()]) return extensionForMime(mimeType);
  const fromSrc = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(src)?.[1]?.toLowerCase();
  if (fromSrc && Object.values(EXTENSION_BY_MIME).includes(fromSrc)) return fromSrc;
  if (fromSrc === "jpeg") return "jpg";
  return extensionForMime(mimeType);
}

/**
 * A file name for the camera roll.
 *
 * Derived from the source path when there is one — the agent named the file for
 * a reason, and that name is how the user will recognise it later. Anything the
 * filesystem might object to is flattened, and the extension is forced to match
 * the actual bytes so a `.png` holding JPEG data does not fail to import.
 */
export function saveFileName(
  source: { src: string; alt?: string; mimeType?: string },
  now: Date = new Date(),
): string {
  const extension = extensionFor(source.src, source.mimeType);

  const fromPath = source.src.startsWith("data:")
    ? undefined
    : source.src.split(/[?#]/)[0]!.split("/").pop();
  const raw = (fromPath || source.alt || "").trim();
  const base = raw
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    // Leading dots too: a generated `.plot.png` would otherwise be saved as a
    // hidden file, and a source named `.png` would collapse to `..png`.
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);

  if (base) return `${base}.${extension}`;

  // Colons are legal in neither iOS album names nor Android file names, so the
  // timestamp is flattened rather than ISO.
  const stamp = now.toISOString().replace(/[:.]/g, "-").replace("T", "-").slice(0, 19);
  return `pew2-${stamp}.${extension}`;
}
